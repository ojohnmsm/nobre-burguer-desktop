package shop.cardapia.pedidos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Os dois canais de notificação do app e as duas notificações que ele posta.
 *
 * - "vigia_servico" (importância baixa, sem som): a notificação fixa do serviço
 *   em primeiro plano, "Recebendo pedidos". Obrigatória para o serviço existir.
 * - "pedido_novo" (importância alta, som próprio no fluxo de ALARME): pedido
 *   novo com o app fora da frente. Insistente — o som repete até alguém abrir a
 *   gaveta ou o app — e com tela cheia, que acende a tela e abre a fila.
 *
 * Som e importância de canal ficam gravados no Android na primeira criação:
 * mudar aqui depois não muda o canal de quem já instalou. Para trocar, crie um
 * canal com outro id (ex.: "pedido_novo_2") e apague o antigo.
 */
final class Notificacoes {
    static final String CANAL_SERVICO = "vigia_servico";
    static final String CANAL_PEDIDO = "pedido_novo";
    static final int ID_SERVICO = 7001;
    static final int ID_PEDIDO = 7002;

    /** Quantos pedidos chegaram desde a última vez que o app esteve na frente. */
    private static int pedidosAcumulados = 0;

    private Notificacoes() {}

    static void criarCanais(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel servico = new NotificationChannel(CANAL_SERVICO, "Recebendo pedidos", NotificationManager.IMPORTANCE_LOW);
        servico.setDescription("Aviso fixo enquanto o tablet está de olho nos pedidos.");
        servico.setShowBadge(false);
        servico.setSound(null, null);
        nm.createNotificationChannel(servico);

        NotificationChannel pedido = new NotificationChannel(CANAL_PEDIDO, "Pedido novo", NotificationManager.IMPORTANCE_HIGH);
        pedido.setDescription("Toca quando chega pedido e o Cardapia não está na tela.");
        pedido.setSound(somDoPedido(ctx), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        pedido.enableVibration(true);
        pedido.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(pedido);
    }

    static Uri somDoPedido(Context ctx) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.pedido_novo);
    }

    private static PendingIntent abrirApp(Context ctx, int codigo) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, codigo, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification doServico(Context ctx, String texto) {
        return new NotificationCompat.Builder(ctx, CANAL_SERVICO)
            .setSmallIcon(R.drawable.ic_stat_pedido)
            .setContentTitle("Recebendo pedidos")
            .setContentText(texto)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(abrirApp(ctx, 1))
            .build();
    }

    /** Pedido novo com o app fora da frente. */
    static synchronized void postarPedidoNovo(Context ctx, String titulo, String texto) {
        pedidosAcumulados += 1;
        String corpo = pedidosAcumulados > 1 ? pedidosAcumulados + " pedidos novos. Último: " + texto : texto;

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CANAL_PEDIDO)
            .setSmallIcon(R.drawable.ic_stat_pedido)
            .setContentTitle(titulo)
            .setContentText(corpo)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(corpo))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(somDoPedido(ctx), android.media.AudioManager.STREAM_ALARM)
            .setAutoCancel(true)
            .setContentIntent(abrirApp(ctx, 2))
            // Acende a tela e abre a fila por cima do bloqueio (a atividade tem
            // showWhenLocked/turnScreenOn). Sem a permissão de tela cheia (Android
            // 14+), o sistema rebaixa para uma notificação flutuante.
            .setFullScreenIntent(abrirApp(ctx, 3), true);

        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;

        try {
            NotificationManagerCompat.from(ctx).notify(ID_PEDIDO, n);
        } catch (SecurityException semPermissao) {
            // POST_NOTIFICATIONS negada: a "Saúde do balcão" mostra isso.
        }
    }

    /** Alguém tocou na tela do app: para o som insistente e zera a contagem. */
    static synchronized void limparPedidos(Context ctx) {
        // Chamado a cada toque: só fala com o sistema se houver o que calar.
        if (pedidosAcumulados == 0) return;
        pedidosAcumulados = 0;
        NotificationManagerCompat.from(ctx).cancel(ID_PEDIDO);
    }

    static boolean permitidas(Context ctx) {
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    static boolean podeTelaCheia(Context ctx) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }
}
