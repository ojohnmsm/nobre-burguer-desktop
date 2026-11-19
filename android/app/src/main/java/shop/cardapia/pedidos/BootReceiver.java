package shop.cardapia.pedidos;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Sobe o vigia quando o tablet liga (BOOT_COMPLETED) e quando o app é
 * atualizado por cima (MY_PACKAGE_REPLACED) — se houver loja pareada e o vigia
 * não tiver sido desligado de propósito. Os dois broadcasts estão entre as
 * exceções que permitem iniciar serviço em primeiro plano a partir do fundo, e
 * o tipo specialUse pode subir no boot (o dataSync não pode no Android 15+).
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String acao = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(acao) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(acao)) return;

        VigiaEstado estado = new VigiaEstado(context);
        if (estado.ativo() && estado.temLojaPareada()) VigiaPedidosService.iniciar(context);
    }
}
