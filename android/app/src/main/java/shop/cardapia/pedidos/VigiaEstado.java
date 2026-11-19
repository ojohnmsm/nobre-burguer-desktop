package shop.cardapia.pedidos;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Tudo que o vigia nativo precisa lembrar entre um processo e outro, num
 * SharedPreferences só dele ("cardapia_vigia" — fora do backup em nuvem, ver
 * res/xml/data_extraction_rules.xml).
 *
 * - config: lojas (token CIFRADO, ver CofreToken) e as regras de impressão;
 * - por loja: ids já vistos, se a primeira varredura da vida dela já rodou, e
 *   o horário do último ciclo bom;
 * - a fila de comandas pendentes de impressão (quem imprime é o JavaScript).
 *
 * Os métodos são synchronized: o laço do serviço e as chamadas do plugin
 * (thread do Capacitor) mexem aqui ao mesmo tempo.
 */
final class VigiaEstado {
    private static final String TAG = "CardapiaVigia";
    private static final String ARQUIVO = "cardapia_vigia";

    /** Teto de ids lembrados por loja — a lista do servidor é bem menor que isso. */
    static final int MAX_VISTOS = 800;
    /** Teto e validade da fila de impressão. */
    static final int MAX_PENDENTES = 60;
    static final long VALIDADE_PENDENTE_MS = 60L * 60 * 1000;

    static final class Conexao {
        final String id;
        final String apiBaseUrl;
        final String label;
        /** Já decifrado; null se o cofre não abriu. */
        final String apiKey;

        Conexao(String id, String apiBaseUrl, String label, String apiKey) {
            this.id = id;
            this.apiBaseUrl = apiBaseUrl;
            this.label = label;
            this.apiKey = apiKey;
        }
    }

    static final class Config {
        final List<Conexao> conexoes = new ArrayList<>();
        boolean autoPrint = true;
        String autoPrintChannels = "all";
        String printerName = "";
    }

    private final SharedPreferences prefs;

    VigiaEstado(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
    }

    // ── Config ──────────────────────────────────────────────────────────

    /**
     * Grava a config vinda do JavaScript. O token chega em texto e sai daqui
     * cifrado. Devolve os ids das lojas que deixaram de existir (para limpar).
     */
    synchronized Set<String> gravarConfig(JSONArray conexoes, boolean autoPrint, String canais, String impressora) {
        Set<String> antigas = new HashSet<>();
        for (Conexao c : lerConfig().conexoes) antigas.add(c.id);

        JSONArray gravar = new JSONArray();
        Set<String> novas = new HashSet<>();
        for (int i = 0; i < conexoes.length(); i++) {
            JSONObject c = conexoes.optJSONObject(i);
            if (c == null) continue;
            String id = c.optString("id", "");
            String url = c.optString("apiBaseUrl", "");
            String chave = c.optString("apiKey", "");
            if (id.isEmpty() || url.isEmpty() || chave.isEmpty()) continue;
            try {
                JSONObject g = new JSONObject();
                g.put("id", id);
                g.put("apiBaseUrl", url);
                g.put("label", c.optString("label", ""));
                g.put("token", CofreToken.cifrar(chave));
                gravar.put(g);
                novas.add(id);
            } catch (Exception e) {
                Log.e(TAG, "Não consegui cifrar o token da loja " + id, e);
            }
        }

        JSONObject cfg = new JSONObject();
        try {
            cfg.put("conexoes", gravar);
            cfg.put("autoPrint", autoPrint);
            cfg.put("autoPrintChannels", canais == null || canais.isEmpty() ? "all" : canais);
            cfg.put("printerName", impressora == null ? "" : impressora);
        } catch (JSONException ignored) {
            // put com chave fixa não lança.
        }
        prefs.edit().putString("config", cfg.toString()).apply();

        antigas.removeAll(novas);
        for (String removida : antigas) esquecerConexao(removida);
        return antigas;
    }

    synchronized Config lerConfig() {
        Config cfg = new Config();
        String bruto = prefs.getString("config", null);
        if (bruto == null) return cfg;
        try {
            JSONObject o = new JSONObject(bruto);
            cfg.autoPrint = o.optBoolean("autoPrint", true);
            cfg.autoPrintChannels = o.optString("autoPrintChannels", "all");
            cfg.printerName = o.optString("printerName", "");
            JSONArray arr = o.optJSONArray("conexoes");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.optJSONObject(i);
                    if (c == null) continue;
                    cfg.conexoes.add(new Conexao(
                        c.optString("id"),
                        c.optString("apiBaseUrl"),
                        c.optString("label", ""),
                        CofreToken.decifrar(c.optString("token", null))
                    ));
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "Config do vigia ilegível", e);
        }
        return cfg;
    }

    synchronized boolean temLojaPareada() {
        return !lerConfig().conexoes.isEmpty();
    }

    /** "O dono quer o vigia ligado" — iniciar() liga, parar() desliga. */
    synchronized boolean ativo() {
        return prefs.getBoolean("ativo", true);
    }

    synchronized void definirAtivo(boolean ativo) {
        prefs.edit().putBoolean("ativo", ativo).apply();
    }

    // ── Estado por loja ─────────────────────────────────────────────────

    synchronized Set<String> vistos(String connId) {
        Set<String> s = new HashSet<>();
        String bruto = prefs.getString("vistos:" + connId, null);
        if (bruto == null) return s;
        try {
            JSONArray arr = new JSONArray(bruto);
            for (int i = 0; i < arr.length(); i++) s.add(arr.optString(i));
        } catch (JSONException ignored) {
            // Lista ilegível = nada visto; a regra dos 20 min segura o estrago.
        }
        return s;
    }

    /** Substitui os vistos da loja pelos ids da lista ATUAL (na ordem da lista, mais recentes primeiro). */
    synchronized void gravarVistos(String connId, List<String> ids) {
        JSONArray arr = new JSONArray();
        Set<String> unicos = new LinkedHashSet<>(ids);
        int n = 0;
        for (String id : unicos) {
            if (n++ >= MAX_VISTOS) break;
            arr.put(id);
        }
        prefs.edit().putString("vistos:" + connId, arr.toString()).apply();
    }

    synchronized boolean primeiraFeita(String connId) {
        return prefs.getBoolean("primeira:" + connId, false);
    }

    synchronized void marcarPrimeiraFeita(String connId) {
        prefs.edit().putBoolean("primeira:" + connId, true).apply();
    }

    synchronized long ultimoSucesso(String connId) {
        return prefs.getLong("ultimoOk:" + connId, 0L);
    }

    synchronized void marcarSucesso(String connId, long quando) {
        prefs.edit().putLong("ultimoOk:" + connId, quando).apply();
    }

    private void esquecerConexao(String connId) {
        prefs.edit()
            .remove("vistos:" + connId)
            .remove("primeira:" + connId)
            .remove("ultimoOk:" + connId)
            .apply();
        // Comanda pendente de loja desligada não sai mais.
        JSONArray atual = lerPendentesBruto();
        JSONArray resto = new JSONArray();
        for (int i = 0; i < atual.length(); i++) {
            JSONObject p = atual.optJSONObject(i);
            if (p != null && !connId.equals(p.optString("connectionId"))) resto.put(p);
        }
        prefs.edit().putString("pendentes", resto.toString()).apply();
    }

    // ── Fila de impressão ───────────────────────────────────────────────

    private JSONArray lerPendentesBruto() {
        try {
            return new JSONArray(prefs.getString("pendentes", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Enfileira (idempotente por id). */
    synchronized void enfileirarImpressao(String orderId, String connId, JSONObject pedido, long agora) {
        JSONArray atual = lerPendentesBruto();
        JSONArray nova = new JSONArray();
        for (int i = 0; i < atual.length(); i++) {
            JSONObject p = atual.optJSONObject(i);
            if (p == null) continue;
            if (orderId.equals(p.optString("id"))) return; // já está na fila
            if (agora - p.optLong("em", 0) > VALIDADE_PENDENTE_MS) continue;
            nova.put(p);
        }
        try {
            JSONObject item = new JSONObject();
            item.put("id", orderId);
            item.put("connectionId", connId);
            item.put("em", agora);
            item.put("pedido", pedido);
            nova.put(item);
        } catch (JSONException ignored) {
            // put com chave fixa não lança.
        }
        // Estourou o teto: sai a mais antiga.
        while (nova.length() > MAX_PENDENTES) nova.remove(0);
        prefs.edit().putString("pendentes", nova.toString()).apply();
    }

    /** Pendentes ainda válidas (as vencidas são descartadas aqui). */
    synchronized JSONArray pendentes(long agora) {
        JSONArray atual = lerPendentesBruto();
        JSONArray validas = new JSONArray();
        for (int i = 0; i < atual.length(); i++) {
            JSONObject p = atual.optJSONObject(i);
            if (p != null && agora - p.optLong("em", 0) <= VALIDADE_PENDENTE_MS) validas.put(p);
        }
        if (validas.length() != atual.length()) prefs.edit().putString("pendentes", validas.toString()).apply();
        return validas;
    }

    synchronized void confirmarImpressos(Set<String> ids) {
        JSONArray atual = lerPendentesBruto();
        JSONArray resto = new JSONArray();
        for (int i = 0; i < atual.length(); i++) {
            JSONObject p = atual.optJSONObject(i);
            if (p != null && !ids.contains(p.optString("id"))) resto.put(p);
        }
        prefs.edit().putString("pendentes", resto.toString()).apply();
    }
}
