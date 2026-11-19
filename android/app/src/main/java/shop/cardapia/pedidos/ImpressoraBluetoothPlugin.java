package shop.cardapia.pedidos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Impressora térmica por Bluetooth clássico (perfil serial, SPP).
 *
 * Faz só duas coisas: lista os aparelhos JÁ pareados no Android e manda bytes
 * crus para um deles. O conteúdo da comanda (ESC/POS) é montado no JavaScript,
 * em src/android/escpos.ts — a mesma comanda do desktop.
 *
 * Os códigos de erro são o contrato com src/android/api.ts, que decide o que
 * dizer na tela:
 *   SEM_PERMISSAO        o usuário negou "dispositivos próximos" (listar e imprimir)
 *   BLUETOOTH_DESLIGADO  sem Bluetooth, ou desligado (listar e imprimir)
 *   CONEXAO              não conectou nem na retentativa (~3 s depois) —
 *                        impressora desligada ou fora de alcance; NADA foi
 *                        enviado, pode tentar de novo
 *   ENVIO                caiu durante o envio — pode ter saído papel, então
 *                        quem chama NÃO deve reimprimir sozinho
 */
@CapacitorPlugin(
    name = "ImpressoraBluetooth",
    permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class ImpressoraBluetoothPlugin extends Plugin {

    /** UUID padrão do perfil de porta serial — o que toda térmica Bluetooth clássica expõe. */
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    /** Uma thread só: duas comandas nunca disputam o mesmo canal. */
    private final ExecutorService fila = Executors.newSingleThreadExecutor();

    /** A permissão em tempo de execução só existe do Android 12 (API 31) em diante. */
    private boolean faltaPermissao() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adaptador() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    @PluginMethod
    public void listarPareadas(PluginCall call) {
        if (faltaPermissao()) {
            requestPermissionForAlias("bluetooth", call, "aposPermissaoListar");
            return;
        }
        listar(call);
    }

    @PermissionCallback
    private void aposPermissaoListar(PluginCall call) {
        if (faltaPermissao()) {
            call.reject("Permissão de dispositivos próximos negada", "SEM_PERMISSAO");
            return;
        }
        listar(call);
    }

    @SuppressLint("MissingPermission")
    private void listar(PluginCall call) {
        BluetoothAdapter adapter = adaptador();
        // Bluetooth desligado é erro com código próprio, não lista vazia: a
        // tela precisa dizer "ligue o Bluetooth", não "nenhuma impressora".
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("O Bluetooth do tablet está desligado", "BLUETOOTH_DESLIGADO");
            return;
        }
        JSArray dispositivos = new JSArray();
        Set<BluetoothDevice> pareados = adapter.getBondedDevices();
        if (pareados != null) {
            for (BluetoothDevice d : pareados) {
                JSObject item = new JSObject();
                item.put("nome", d.getName() == null ? "" : d.getName());
                item.put("endereco", d.getAddress());
                dispositivos.put(item);
            }
        }
        JSObject resposta = new JSObject();
        resposta.put("dispositivos", dispositivos);
        call.resolve(resposta);
    }

    /** Situação do Bluetooth sem pedir nada (para a "Saúde do balcão"). */
    @PluginMethod
    public void estado(PluginCall call) {
        BluetoothAdapter adapter = adaptador();
        JSObject r = new JSObject();
        r.put("existe", adapter != null);
        r.put("ligado", adapter != null && adapter.isEnabled());
        r.put("permitido", !faltaPermissao());
        call.resolve(r);
    }

    /** Pede "dispositivos próximos" e devolve se ficou permitido. */
    @PluginMethod
    public void pedirPermissao(PluginCall call) {
        if (!faltaPermissao()) {
            JSObject r = new JSObject();
            r.put("permitido", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "aposPedirPermissao");
    }

    @PermissionCallback
    private void aposPedirPermissao(PluginCall call) {
        JSObject r = new JSObject();
        r.put("permitido", !faltaPermissao());
        call.resolve(r);
    }

    @PluginMethod
    public void imprimir(PluginCall call) {
        if (faltaPermissao()) {
            requestPermissionForAlias("bluetooth", call, "aposPermissaoImprimir");
            return;
        }
        fila.execute(() -> enviar(call));
    }

    @PermissionCallback
    private void aposPermissaoImprimir(PluginCall call) {
        if (faltaPermissao()) {
            call.reject("Permissão de dispositivos próximos negada", "SEM_PERMISSAO");
            return;
        }
        fila.execute(() -> enviar(call));
    }

    @SuppressLint("MissingPermission")
    private void enviar(PluginCall call) {
        String endereco = call.getString("endereco", "");
        String dadosBase64 = call.getString("dadosBase64", "");

        byte[] dados;
        try {
            dados = Base64.decode(dadosBase64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Comanda inválida", "CONEXAO");
            return;
        }

        BluetoothAdapter adapter = adaptador();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth desligado", "BLUETOOTH_DESLIGADO");
            return;
        }

        BluetoothSocket socket = null;
        try {
            BluetoothDevice device;
            try {
                device = adapter.getRemoteDevice(endereco);
            } catch (IllegalArgumentException e) {
                call.reject("Impressora não configurada", "CONEXAO");
                return;
            }

            socket = conectar(device);
            if (socket == null) {
                // Impressora acordando, ou o rádio ocupado com a anterior: uma
                // retentativa depois de um respiro. Nada foi enviado ainda.
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                socket = conectar(device);
            }
            if (socket == null) {
                call.reject("Impressora desligada ou fora de alcance", "CONEXAO");
                return;
            }

            try {
                OutputStream out = socket.getOutputStream();
                // Em pedaços, com um respiro: o buffer de térmica barata é
                // pequeno e o QR em imagem estoura ele se for tudo de uma vez.
                final int bloco = 1024;
                for (int i = 0; i < dados.length; i += bloco) {
                    out.write(dados, i, Math.min(bloco, dados.length - i));
                    out.flush();
                    Thread.sleep(25);
                }
                // Fechar logo depois do último byte corta o fim da comanda em
                // várias impressoras; espera o que já foi mandado sair.
                Thread.sleep(700 + dados.length / 40);
            } catch (IOException | InterruptedException e) {
                call.reject("A conexão com a impressora caiu durante o envio", "ENVIO");
                return;
            }

            call.resolve();
        } finally {
            fechar(socket);
        }
    }

    /** Canal autenticado e, se recusar, o "inseguro". Null se nenhum conectou. */
    @SuppressLint("MissingPermission")
    private BluetoothSocket conectar(BluetoothDevice device) {
        BluetoothSocket socket = null;
        try {
            socket = device.createRfcommSocketToServiceRecord(SPP);
            socket.connect();
            return socket;
        } catch (IOException primeira) {
            fechar(socket);
            // Clones baratos recusam o canal autenticado e só aceitam o
            // "inseguro". Nada foi enviado ainda, então tentar é seguro.
            BluetoothSocket inseguro = null;
            try {
                inseguro = device.createInsecureRfcommSocketToServiceRecord(SPP);
                inseguro.connect();
                return inseguro;
            } catch (IOException segunda) {
                fechar(inseguro);
                return null;
            }
        }
    }

    private void fechar(BluetoothSocket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (IOException ignored) {
            // Já estava fechado.
        }
    }
}
