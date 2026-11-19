package shop.cardapia.pedidos;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String PREFS_TELA = "cardapia_tela";
    private static final String CHAVE_TELA_LIGADA = "telaLigada";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImpressoraBluetoothPlugin.class);
        registerPlugin(VigiaPlugin.class);
        super.onCreate(savedInstanceState);

        // Tela ligada é preferência NATIVA, lida aqui: vale antes de o JS
        // carregar. O padrão é ligada (tablet de balcão, na tomada).
        aplicarTelaLigada(this, telaLigadaPreferida(this));

        // Pedido novo com a tela apagada/bloqueada: a notificação de tela cheia
        // abre esta atividade, que acende a tela e aparece por cima do bloqueio
        // (com PIN/padrão, a fila aparece mas o resto do tablet segue bloqueado).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }

        // O alerta de pedido novo toca sozinho, sem ninguém ter tocado na tela.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);

        // Voltar NÃO tira o app da frente: no Android 16 com target 36 o voltar
        // na atividade raiz manda o app para o fundo (e aí a tela apaga). Se a
        // WebView tiver histórico, volta nela; senão, não faz nada.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() == null ? null : getBridge().getWebView();
                if (wv != null && wv.canGoBack()) wv.goBack();
            }
        });

        esconderBarrasDoSistema();

        // Sobe o vigia nativo com o app na frente (é quando o Android sempre
        // deixa iniciar serviço em primeiro plano). Sem loja pareada ele se
        // desliga sozinho.
        VigiaEstado estado = new VigiaEstado(this);
        if (estado.ativo() && estado.temLojaPareada()) VigiaPedidosService.iniciar(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        VigiaHub.naFrente = true;
        // NÃO cancela o alarme aqui: com a tela apagada, a notificação de tela
        // cheia abre esta atividade sozinha, e cancelar no onResume calaria o
        // som no mesmo segundo em que a tela acende. Quem cala é o primeiro
        // toque (onUserInteraction) — "insistente até alguém mexer".
        VigiaPedidosService.verificarAgora();
    }

    @Override
    public void onUserInteraction() {
        super.onUserInteraction();
        Notificacoes.limparPedidos(this);
    }

    @Override
    public void onPause() {
        // Inclui a tela apagando: daí em diante pedido novo vira notificação.
        VigiaHub.naFrente = false;
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) esconderBarrasDoSistema();
    }

    /** Tela cheia de balcão: as barras do Android voltam com um deslize da borda. */
    private void esconderBarrasDoSistema() {
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    // ── Preferência "manter a tela ligada" ─────────────────────────────

    static boolean telaLigadaPreferida(Context ctx) {
        SharedPreferences p = ctx.getApplicationContext().getSharedPreferences(PREFS_TELA, Context.MODE_PRIVATE);
        return p.getBoolean(CHAVE_TELA_LIGADA, true);
    }

    static void gravarTelaLigada(Context ctx, boolean ligar) {
        ctx.getApplicationContext().getSharedPreferences(PREFS_TELA, Context.MODE_PRIVATE)
            .edit().putBoolean(CHAVE_TELA_LIGADA, ligar).apply();
    }

    /** FLAG_KEEP_SCREEN_ON só vale com a atividade à vista — o serviço cobre o resto. */
    static void aplicarTelaLigada(Activity a, boolean ligar) {
        if (ligar) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
