package shop.cardapia.pedidos;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * O vigia de pedidos do tablet: serviço em primeiro plano, nativo, que vive
 * independente da WebView. É ele quem decide o que é pedido NOVO.
 *
 * Por que nativo: a WebView do Capacitor tem os timers estrangulados pelo
 * Chromium com a página oculta, e o Android congela o processo de app em
 * segundo plano sem serviço em primeiro plano. Com o vigia em JS, app no fundo
 * ou tela apagada = pedido sem aviso.
 *
 * Tipo specialUse (não dataSync: o dataSync tem teto de 6 h/dia no Android 15+
 * e não pode subir no boot). PARTIAL_WAKE_LOCK + WifiLock enquanto roda: o
 * tablet do balcão fica na tomada, o custo de bateria não importa e a CPU/Wi-Fi
 * dormindo é exatamente o que perderia pedido.
 *
 * ── CONTRATO: TRÊS CÓPIAS DA MESMA REGRA ────────────────────────────────────
 * electron/main.ts (vigiarPedidosNovos), src/android/api.ts (vigiarPedidosNovos,
 * o recuo quando este plugin não existe) e ESTE arquivo (ciclo). Mudou uma
 * regra num, mude nos três:
 *   - GET /api/desktop/orders de cada loja, Bearer + If-None-Match (ETag), a
 *     cada 7 s depois do fim do ciclo anterior (nunca dois em voo);
 *   - pedidos de todas as lojas juntos, dedupe por id (mesma loja ligada duas
 *     vezes), mais recentes primeiro; todas falharam = ciclo perdido, nada muda;
 *   - descarta status 'awaiting_payment';
 *   - "visto" é POR LOJA e só é refeito para quem respondeu neste ciclo;
 *   - a primeira varredura não avisa;
 *   - pedido com created_at de mais de 20 min não é avisado nem impresso;
 *   - imprime se autoPrint, impressora escolhida e o canal passa no filtro
 *     (all / own / ifood — ifood = iFood e 99Food).
 * Diferenças DELIBERADAS deste: o "visto", a "primeira varredura" e o último
 * ciclo bom são PERSISTIDOS por loja — serviço reiniciado (boot, processo
 * morto) avisa o que chegou enquanto esteve fora, respeitando os 20 min; só a
 * primeira varredura DA VIDA de cada loja é silenciosa (loja recém-ligada não
 * despeja os pedidos dos últimos 20 min). E quem imprime é o JavaScript, pela
 * fila persistida (VigiaEstado), porque a comanda é montada lá.
 */
public class VigiaPedidosService extends Service {
    private static final String TAG = "CardapiaVigia";
    static final long INTERVALO_MS = 7_000;
    static final long NOVO_PEDIDO_RECENTE_MS = 20L * 60 * 1000;
    private static final int TEMPO_CONEXAO_MS = 15_000;
    private static final int TEMPO_LEITURA_MS = 25_000;

    private static volatile VigiaPedidosService instancia = null;

    private ScheduledExecutorService agendador;
    private ExecutorService rede;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private VigiaEstado estado;
    private boolean lacoAgendado = false;
    private String textoNotificacaoAtual = "";

    /** ETag + última lista por loja (em memória: perder no reinício só custa um 200). */
    private final Map<String, String> etags = new ConcurrentHashMap<>();
    private final Map<String, JSONArray> cacheLista = new ConcurrentHashMap<>();
    /** Estado de cada loja no último ciclo, para a saúde. */
    private final Map<String, String> estadoConexao = new ConcurrentHashMap<>();
    private volatile long diferencaRelogioMs = 0;

    // ── Ligar / desligar de fora ────────────────────────────────────────

    static void iniciar(Context ctx) {
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, VigiaPedidosService.class));
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException (app em segundo plano sem
            // isenção) e afins: na próxima vez que o app vier à frente, sobe.
            Log.w(TAG, "Não consegui subir o vigia agora", e);
        }
    }

    static void parar(Context ctx) {
        ctx.stopService(new Intent(ctx, VigiaPedidosService.class));
    }

    /** Ciclo extra agora (pedido de balcão criado, app voltou à frente). */
    static void verificarAgora() {
        VigiaPedidosService s = instancia;
        if (s != null && s.agendador != null) s.agendador.execute(s::cicloSeguro);
    }

    // ── Ciclo de vida ───────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instancia = this;
        estado = new VigiaEstado(this);
        Notificacoes.criarCanais(this);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cardapia:vigia");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            @SuppressWarnings("deprecation")
            int modo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(modo, "cardapia:vigia");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }

        agendador = Executors.newSingleThreadScheduledExecutor();
        rede = Executors.newCachedThreadPool();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // startForeground tem de vir logo, antes de qualquer decisão: o Android
        // derruba o app se um serviço iniciado com startForegroundService não
        // chamar isso em poucos segundos.
        Notification n = Notificacoes.doServico(this, "Pedido novo toca mesmo com a tela apagada.");
        textoNotificacaoAtual = "Pedido novo toca mesmo com a tela apagada.";
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Notificacoes.ID_SERVICO, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(Notificacoes.ID_SERVICO, n);
            }
        } catch (Exception e) {
            Log.e(TAG, "startForeground recusado", e);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!estado.ativo() || !estado.temLojaPareada()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        VigiaHub.servicoRodando = true;
        if (!lacoAgendado) {
            lacoAgendado = true;
            // Fixed DELAY: o próximo ciclo conta 7 s a partir do FIM deste — igual
            // ao setTimeout reagendado do desktop. Nunca dois ciclos em voo.
            agendador.scheduleWithFixedDelay(this::cicloSeguro, 1_000, INTERVALO_MS, TimeUnit.MILLISECONDS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        VigiaHub.servicoRodando = false;
        instancia = null;
        if (agendador != null) agendador.shutdownNow();
        if (rede != null) rede.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── O ciclo ─────────────────────────────────────────────────────────

    /** Exceção escapando do Runnable cancelaria o agendamento para sempre. */
    private void cicloSeguro() {
        try {
            ciclo();
        } catch (Throwable t) {
            Log.e(TAG, "Ciclo do vigia falhou", t);
        }
    }

    private static final class Resultado {
        final VigiaEstado.Conexao conexao;
        JSONArray pedidos; // null = falhou
        String estado;

        Resultado(VigiaEstado.Conexao c) {
            conexao = c;
        }
    }

    private void ciclo() {
        VigiaEstado.Config cfg = estado.lerConfig();
        List<VigiaEstado.Conexao> conexoes = new ArrayList<>();
        for (VigiaEstado.Conexao c : cfg.conexoes) {
            if (c.apiKey != null && !c.apiKey.isEmpty() && urlValida(c.apiBaseUrl)) conexoes.add(c);
        }
        if (cfg.conexoes.isEmpty()) {
            // Loja desligada de tudo: não há o que vigiar.
            stopSelf();
            return;
        }
        if (conexoes.isEmpty()) {
            emitirSaude(cfg, conexoes);
            return;
        }

        // Todas as lojas em paralelo, como o Promise.allSettled do desktop.
        List<Future<Resultado>> futuros = new ArrayList<>();
        for (VigiaEstado.Conexao c : conexoes) futuros.add(rede.submit(() -> buscar(c)));

        List<Resultado> resultados = new ArrayList<>();
        for (int i = 0; i < futuros.size(); i++) {
            Resultado r;
            try {
                r = futuros.get(i).get(TEMPO_CONEXAO_MS + TEMPO_LEITURA_MS + 5_000, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                r = new Resultado(conexoes.get(i));
                r.estado = "sem_rede";
            }
            resultados.add(r);
            estadoConexao.put(r.conexao.id, r.estado);
        }

        boolean etiquetar = conexoes.size() > 1;
        List<JSONObject> juntos = new ArrayList<>();
        Set<String> conexoesOk = new HashSet<>();
        for (Resultado r : resultados) {
            if (r.pedidos == null) continue;
            conexoesOk.add(r.conexao.id);
            for (int i = 0; i < r.pedidos.length(); i++) {
                JSONObject p = r.pedidos.optJSONObject(i);
                if (p == null) continue;
                try {
                    p.put("connectionId", r.conexao.id);
                    p.put("storeLabel", etiquetar ? (r.conexao.label.isEmpty() ? "Loja" : r.conexao.label) : "");
                } catch (JSONException ignored) {
                    // put com chave fixa não lança.
                }
                juntos.add(p);
            }
        }

        if (conexoesOk.isEmpty()) {
            // Todas falharam: erro, não lista vazia — lista vazia faria a próxima
            // carga boa tratar os pedidos de ontem como novos.
            emitirSaude(cfg, conexoes);
            return;
        }

        // Dedupe por id (uuid): dois códigos da MESMA loja trariam tudo em dobro.
        Set<String> idsVistosAgora = new HashSet<>();
        List<JSONObject> unicos = new ArrayList<>();
        for (JSONObject p : juntos) {
            String id = textoOuVazio(p, "id");
            if (id.isEmpty() || idsVistosAgora.contains(id)) continue;
            idsVistosAgora.add(id);
            unicos.add(p);
        }
        Collections.sort(unicos, (a, b) -> textoOuVazio(b, "created_at").compareTo(textoOuVazio(a, "created_at")));

        List<JSONObject> operacionais = new ArrayList<>();
        for (JSONObject p : unicos) {
            if (!"awaiting_payment".equals(textoOuVazio(p, "status"))) operacionais.add(p);
        }

        // Novos: só de loja que já passou da primeira varredura da vida.
        Map<String, Set<String>> vistosPorLoja = new HashMap<>();
        Map<String, Boolean> primeiraPorLoja = new HashMap<>();
        for (VigiaEstado.Conexao c : conexoes) {
            vistosPorLoja.put(c.id, estado.vistos(c.id));
            primeiraPorLoja.put(c.id, estado.primeiraFeita(c.id));
        }
        List<JSONObject> novos = new ArrayList<>();
        for (JSONObject p : operacionais) {
            String conn = textoOuVazio(p, "connectionId");
            if (!Boolean.TRUE.equals(primeiraPorLoja.get(conn))) continue;
            Set<String> vistos = vistosPorLoja.get(conn);
            if (vistos != null && !vistos.contains(textoOuVazio(p, "id"))) novos.add(p);
        }

        // Só refaz o "visto" de quem respondeu agora.
        long agora = System.currentTimeMillis();
        for (String conn : conexoesOk) {
            List<String> ids = new ArrayList<>();
            for (JSONObject p : operacionais) {
                if (conn.equals(textoOuVazio(p, "connectionId"))) ids.add(textoOuVazio(p, "id"));
            }
            estado.gravarVistos(conn, ids);
            estado.marcarPrimeiraFeita(conn);
            estado.marcarSucesso(conn, agora);
        }

        JSONArray lista = new JSONArray();
        for (JSONObject p : operacionais) lista.put(p);
        VigiaHub.ultimaLista = lista;
        VigiaHub.ultimoCicloEm = agora;
        VigiaHub.Ouvinte ouvinte = VigiaHub.ouvinte;
        // A lista só vai para a WebView com a tela à vista: no fundo ela não
        // desenharia nada, e ao voltar o JS pede estado() de uma vez.
        if (VigiaHub.naFrente && ouvinte != null) ouvinte.pedidosAtualizados(lista);

        for (JSONObject p : novos) {
            long criado = instanteIso(textoOuVazio(p, "created_at"));
            // Data ilegível não pula (no JS, `agora - NaN > x` é falso).
            if (criado != Long.MIN_VALUE && agora - criado > NOVO_PEDIDO_RECENTE_MS) continue;

            String id = textoOuVazio(p, "id");
            String canal = p.isNull("channel") ? "web" : p.optString("channel", "web");
            String label = rotulo(p);
            String cliente = textoOuVazio(p, "customer_name");
            boolean retirada = "pickup".equals(textoOuVazio(p, "fulfillment_type"));
            boolean imprimir = cfg.autoPrint && !cfg.printerName.isEmpty() && deveImprimirCanal(canal, cfg.autoPrintChannels);

            if (imprimir) estado.enfileirarImpressao(id, textoOuVazio(p, "connectionId"), p, agora);

            JSONObject info = new JSONObject();
            try {
                info.put("id", id);
                info.put("label", label);
                info.put("canal", canal);
                info.put("customerName", cliente);
                info.put("isPickup", retirada);
            } catch (JSONException ignored) {
                // put com chave fixa não lança.
            }

            ouvinte = VigiaHub.ouvinte;
            if (VigiaHub.naFrente && ouvinte != null) {
                ouvinte.novoPedido(info, p, imprimir);
            } else {
                String origem = "ifood".equals(canal) ? " iFood"
                    : "99food".equals(canal) ? " 99Food"
                    : "whatsapp".equals(canal) ? " WhatsApp"
                    : "";
                Notificacoes.postarPedidoNovo(this,
                    (retirada ? "RETIRADA — " : "") + "Novo pedido" + origem,
                    "#" + label + (cliente.isEmpty() ? "" : " — " + cliente));
            }
        }

        emitirSaude(cfg, conexoes);
    }

    private Resultado buscar(VigiaEstado.Conexao c) {
        Resultado r = new Resultado(c);
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(c.apiBaseUrl + "/api/desktop/orders").openConnection();
            con.setConnectTimeout(TEMPO_CONEXAO_MS);
            con.setReadTimeout(TEMPO_LEITURA_MS);
            con.setUseCaches(false);
            con.setRequestProperty("Authorization", "Bearer " + c.apiKey);
            con.setRequestProperty("Accept", "application/json");
            String etag = etags.get(c.id);
            JSONArray cache = cacheLista.get(c.id);
            if (etag != null && cache != null) con.setRequestProperty("If-None-Match", etag);

            int status = con.getResponseCode();
            long dataServidor = con.getHeaderFieldDate("Date", 0L);
            if (dataServidor > 0) diferencaRelogioMs = dataServidor - System.currentTimeMillis();

            if (status == 304 && cache != null) {
                r.pedidos = new JSONArray(cache.toString());
                r.estado = "ok";
                return r;
            }
            if (status == 401 || status == 403) {
                r.estado = "nao_autorizado";
                return r;
            }
            if (status < 200 || status >= 300) {
                r.estado = "erro_servidor";
                return r;
            }

            String corpo = lerTudo(con.getInputStream());
            JSONArray pedidos;
            try {
                Object v = corpo.isEmpty() ? null : new org.json.JSONTokener(corpo).nextValue();
                pedidos = v instanceof JSONArray ? (JSONArray) v : new JSONArray();
            } catch (JSONException e) {
                pedidos = new JSONArray();
            }
            String novaEtag = con.getHeaderField("ETag");
            if (novaEtag != null) {
                etags.put(c.id, novaEtag);
                cacheLista.put(c.id, new JSONArray(pedidos.toString()));
            } else {
                etags.remove(c.id);
                cacheLista.remove(c.id);
            }
            r.pedidos = pedidos;
            r.estado = "ok";
        } catch (IOException e) {
            r.estado = "sem_rede";
        } catch (JSONException e) {
            r.estado = "erro_servidor";
        } finally {
            if (con != null) con.disconnect();
        }
        return r;
    }

    private void emitirSaude(VigiaEstado.Config cfg, List<VigiaEstado.Conexao> conexoes) {
        JSONObject saude = new JSONObject();
        JSONArray lista = new JSONArray();
        boolean todasOk = true;
        try {
            for (VigiaEstado.Conexao c : conexoes) {
                JSONObject o = new JSONObject();
                String est = estadoConexao.get(c.id);
                if (est == null) est = "sem_rede";
                if (!"ok".equals(est)) todasOk = false;
                long ultimo = estado.ultimoSucesso(c.id);
                o.put("connectionId", c.id);
                o.put("label", c.label);
                o.put("estado", est);
                o.put("ultimoSucessoEm", ultimo > 0 ? ultimo : JSONObject.NULL);
                lista.put(o);
            }
            saude.put("conexoes", lista);
            saude.put("diferencaRelogioMs", diferencaRelogioMs);
            saude.put("autoPrintSemImpressora", cfg.autoPrint && cfg.printerName.isEmpty());
        } catch (JSONException ignored) {
            // put com chave fixa não lança.
        }
        VigiaHub.ultimaSaude = saude;
        VigiaHub.Ouvinte ouvinte = VigiaHub.ouvinte;
        if (ouvinte != null) ouvinte.saude(saude);

        String texto = todasOk ? "Pedido novo toca mesmo com a tela apagada." : "Sem resposta do servidor. Tentando de novo a cada 7 segundos.";
        if (!texto.equals(textoNotificacaoAtual)) {
            textoNotificacaoAtual = texto;
            try {
                androidx.core.app.NotificationManagerCompat.from(this)
                    .notify(Notificacoes.ID_SERVICO, Notificacoes.doServico(this, texto));
            } catch (SecurityException ignored) {
                // Sem permissão de notificação: o serviço segue, só não aparece.
            }
        }
    }

    // ── Utilitários (espelham o JS) ─────────────────────────────────────

    static boolean urlValida(String url) {
        if (url == null) return false;
        String u = url.toLowerCase(Locale.ROOT);
        return u.startsWith("https://") || u.startsWith("http://");
    }

    static boolean ehMarketplace(String canal) {
        return "ifood".equals(canal) || "99food".equals(canal);
    }

    static boolean deveImprimirCanal(String canal, String filtro) {
        if ("ifood".equals(filtro)) return ehMarketplace(canal);
        if ("own".equals(filtro)) return !ehMarketplace(canal);
        return true;
    }

    /** String do campo, ou "" se ausente/null (o `String(x ?? '')` do JS). */
    static String textoOuVazio(JSONObject o, String campo) {
        if (o == null || !o.has(campo) || o.isNull(campo)) return "";
        return String.valueOf(o.opt(campo));
    }

    /** Porte de orderLabel() de electron/receiptFormat.ts. */
    static String rotulo(JSONObject p) {
        String canal = textoOuVazio(p, "channel");
        String id = textoOuVazio(p, "id");
        String curto = (id.length() > 8 ? id.substring(0, 8) : id).toUpperCase(Locale.ROOT);
        if ("ifood".equals(canal)) return p.has("ifood_display_id") && !p.isNull("ifood_display_id") ? textoOuVazio(p, "ifood_display_id") : curto;
        if ("99food".equals(canal)) return p.has("opendelivery_display_id") && !p.isNull("opendelivery_display_id") ? textoOuVazio(p, "opendelivery_display_id") : curto;

        JSONObject lojas = p.optJSONObject("stores");
        String loja = lojas == null ? "" : textoOuVazio(lojas, "store_number");
        String numero = textoOuVazio(p, "order_number");
        boolean temLoja = verdadeiro(loja);
        boolean temNumero = verdadeiro(numero);
        if (temLoja && temNumero) return completar(loja, 2) + completar(numero, 3);
        if (temNumero) return numero;
        return curto;
    }

    /** Valor "verdadeiro" no sentido do JS: não vazio e não zero. */
    private static boolean verdadeiro(String v) {
        return !v.isEmpty() && !"0".equals(v) && !"false".equals(v);
    }

    private static String completar(String v, int tamanho) {
        StringBuilder sb = new StringBuilder();
        for (int i = v.length(); i < tamanho; i++) sb.append('0');
        return sb.append(v).toString();
    }

    private static final Pattern ISO = Pattern.compile(
        "^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}(?::?\\d{2})?)?$");

    /** Milissegundos de um ISO 8601 (o created_at do Postgres), ou Long.MIN_VALUE se ilegível. */
    static long instanteIso(String s) {
        if (s == null) return Long.MIN_VALUE;
        Matcher m = ISO.matcher(s.trim());
        if (!m.matches()) return Long.MIN_VALUE;
        try {
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            cal.clear();
            cal.set(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)) - 1, Integer.parseInt(m.group(3)),
                Integer.parseInt(m.group(4)), Integer.parseInt(m.group(5)), m.group(6) == null ? 0 : Integer.parseInt(m.group(6)));
            long ms = cal.getTimeInMillis();
            String frac = m.group(7);
            if (frac != null) {
                String tres = (frac + "000").substring(0, 3);
                ms += Integer.parseInt(tres);
            }
            String zona = m.group(8);
            if (zona != null && !"Z".equals(zona)) {
                int sinal = zona.charAt(0) == '-' ? -1 : 1;
                String digitos = zona.substring(1).replace(":", "");
                int horas = Integer.parseInt(digitos.substring(0, 2));
                int minutos = digitos.length() >= 4 ? Integer.parseInt(digitos.substring(2, 4)) : 0;
                ms -= sinal * (horas * 3_600_000L + minutos * 60_000L);
            }
            // Sem zona: o JS lê como hora LOCAL. O Postgres sempre manda a zona;
            // aqui fica UTC por simplicidade — e a data ilegível já não pula.
            return ms;
        } catch (RuntimeException e) {
            return Long.MIN_VALUE;
        }
    }

    private static String lerTudo(InputStream in) throws IOException {
        try (InputStream entrada = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = entrada.read(buf)) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
