package shop.cardapia.pedidos;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Ponte entre src/android/api.ts e o vigia nativo (VigiaPedidosService).
 *
 * Eventos (notifyListeners):
 *   pedidosAtualizados { pedidos }                — a cada ciclo, só com o app na frente
 *   novoPedido         { info, pedido, imprimir } — pedido novo com o app na frente
 *   saude              { conexoes, diferencaRelogioMs, autoPrintSemImpressora }
 */
@CapacitorPlugin(
    name = "Vigia",
    permissions = { @Permission(alias = "notificacoes", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class VigiaPlugin extends Plugin {

    private VigiaEstado estado;
    private VigiaHub.Ouvinte ouvinte;

    @Override
    public void load() {
        estado = new VigiaEstado(getContext());
        Notificacoes.criarCanais(getContext());
        ouvinte = new VigiaHub.Ouvinte() {
            @Override
            public void pedidosAtualizados(JSONArray pedidos) {
                JSObject d = new JSObject();
                d.put("pedidos", pedidos);
                notifyListeners("pedidosAtualizados", d);
            }

            @Override
            public void novoPedido(JSONObject info, JSONObject pedido, boolean imprimir) {
                JSObject d = new JSObject();
                d.put("info", info);
                d.put("pedido", pedido);
                d.put("imprimir", imprimir);
                notifyListeners("novoPedido", d);
            }

            @Override
            public void saude(JSONObject saude) {
                try {
                    notifyListeners("saude", new JSObject(saude.toString()));
                } catch (JSONException ignored) {
                    // Veio de um JSONObject válido.
                }
            }
        };
        VigiaHub.ouvinte = ouvinte;
    }

    @Override
    protected void handleOnDestroy() {
        if (VigiaHub.ouvinte == ouvinte) VigiaHub.ouvinte = null;
        super.handleOnDestroy();
    }

    // ── Config e ciclo ──────────────────────────────────────────────────

    @PluginMethod
    public void configurar(PluginCall call) {
        JSArray conexoes = call.getArray("conexoes", new JSArray());
        boolean autoPrint = Boolean.TRUE.equals(call.getBoolean("autoPrint", true));
        String canais = call.getString("autoPrintChannels", "all");
        String impressora = call.getString("printerName", "");
        estado.gravarConfig(conexoes, autoPrint, canais, impressora);

        if (!estado.temLojaPareada()) {
            VigiaPedidosService.parar(getContext());
        } else if (estado.ativo()) {
            VigiaPedidosService.iniciar(getContext());
            VigiaPedidosService.verificarAgora();
        }
        call.resolve();
    }

    @PluginMethod
    public void iniciar(PluginCall call) {
        estado.definirAtivo(true);
        if (estado.temLojaPareada()) VigiaPedidosService.iniciar(getContext());
        JSObject r = new JSObject();
        r.put("lojaPareada", estado.temLojaPareada());
        call.resolve(r);
    }

    @PluginMethod
    public void parar(PluginCall call) {
        estado.definirAtivo(false);
        VigiaPedidosService.parar(getContext());
        call.resolve();
    }

    @PluginMethod
    public void verificarAgora(PluginCall call) {
        VigiaPedidosService.verificarAgora();
        call.resolve();
    }

    @PluginMethod
    public void estado(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        r.put("rodando", VigiaHub.servicoRodando);
        r.put("ativo", estado.ativo());
        r.put("lojaPareada", estado.temLojaPareada());
        r.put("ultimoCicloEm", VigiaHub.ultimoCicloEm > 0 ? VigiaHub.ultimoCicloEm : null);
        JSONArray lista = VigiaHub.ultimaLista;
        if (lista != null) r.put("pedidos", lista);
        JSONObject saude = VigiaHub.ultimaSaude;
        if (saude != null) r.put("saude", saude);
        r.put("notificacoes", Notificacoes.permitidas(ctx));
        r.put("isentoBateria", isentoBateria(ctx));
        r.put("podeTelaCheia", Notificacoes.podeTelaCheia(ctx));
        r.put("telaLigada", MainActivity.telaLigadaPreferida(ctx));
        call.resolve(r);
    }

    // ── Fila de impressão ───────────────────────────────────────────────

    @PluginMethod
    public void pendentesDeImpressao(PluginCall call) {
        JSObject r = new JSObject();
        r.put("pendentes", estado.pendentes(System.currentTimeMillis()));
        call.resolve(r);
    }

    @PluginMethod
    public void confirmarImpressos(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        Set<String> s = new HashSet<>();
        for (int i = 0; i < ids.length(); i++) s.add(ids.optString(i));
        estado.confirmarImpressos(s);
        call.resolve();
    }

    // ── Permissões e ajustes do sistema ─────────────────────────────────

    @PluginMethod
    public void pedirPermissaoNotificacao(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notificacoes") == PermissionState.GRANTED) {
            responderNotificacao(call);
            return;
        }
        requestPermissionForAlias("notificacoes", call, "aposPermissaoNotificacao");
    }

    @PermissionCallback
    private void aposPermissaoNotificacao(PluginCall call) {
        responderNotificacao(call);
    }

    private void responderNotificacao(PluginCall call) {
        JSObject r = new JSObject();
        r.put("permitido", Notificacoes.permitidas(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void pedirIsencaoBateria(PluginCall call) {
        Context ctx = getContext();
        if (isentoBateria(ctx)) {
            JSObject r = new JSObject();
            r.put("isento", true);
            call.resolve(r);
            return;
        }
        // Pede direto (diálogo do sistema). Se o aparelho não tiver a tela,
        // cai na lista geral de otimização de bateria.
        if (!abrir(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName())))) {
            abrir(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
        JSObject r = new JSObject();
        r.put("isento", false);
        call.resolve(r);
    }

    @PluginMethod
    public void podeTelaCheia(PluginCall call) {
        JSObject r = new JSObject();
        r.put("pode", Notificacoes.podeTelaCheia(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void abrirAjusteTelaCheia(PluginCall call) {
        Context ctx = getContext();
        boolean abriu = false;
        if (Build.VERSION.SDK_INT >= 34) {
            abriu = abrir(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + ctx.getPackageName())));
        }
        if (!abriu) abrirDetalhesDoApp();
        call.resolve();
    }

    @PluginMethod
    public void abrirAjustesDoApp(PluginCall call) {
        abrirDetalhesDoApp();
        call.resolve();
    }

    @PluginMethod
    public void manterTelaLigada(PluginCall call) {
        boolean ligar = Boolean.TRUE.equals(call.getBoolean("ligar", true));
        MainActivity.gravarTelaLigada(getContext(), ligar);
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(() -> MainActivity.aplicarTelaLigada(a, ligar));
        call.resolve();
    }

    // ── Auxiliares ──────────────────────────────────────────────────────

    static boolean isentoBateria(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    private void abrirDetalhesDoApp() {
        abrir(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
    }

    private boolean abrir(Intent i) {
        Activity a = getActivity();
        try {
            if (a != null) {
                a.startActivity(i);
            } else {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }
}
