package shop.cardapia.pedidos;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Ponto de encontro entre o serviço (VigiaPedidosService), a atividade e o
 * plugin (VigiaPlugin), que vivem no mesmo processo mas nascem e morrem em
 * momentos diferentes.
 *
 * `naFrente` é o sinal confiável de "a tela do Cardapia está à vista":
 * MainActivity liga no onResume e desliga no onPause (inclusive quando a tela
 * apaga). É ele que decide entre notificação sonora do Android (app fora da
 * frente) e só o evento para o JavaScript (app na frente — o JS toca o som
 * configurado e mostra o aviso; as duas coisas juntas seriam aviso em dobro).
 */
final class VigiaHub {
    interface Ouvinte {
        void pedidosAtualizados(JSONArray pedidos);
        void novoPedido(JSONObject info, JSONObject pedido, boolean imprimir);
        void saude(JSONObject saude);
    }

    static volatile boolean naFrente = false;
    static volatile Ouvinte ouvinte = null;
    static volatile boolean servicoRodando = false;

    /** Última lista e última saúde, para o JS pedir ao voltar à frente. */
    static volatile JSONArray ultimaLista = null;
    static volatile JSONObject ultimaSaude = null;
    static volatile long ultimoCicloEm = 0L;

    private VigiaHub() {}
}
