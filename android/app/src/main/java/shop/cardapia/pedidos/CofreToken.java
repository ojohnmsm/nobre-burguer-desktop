package shop.cardapia.pedidos;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Cifra o token da loja com AES-GCM, chave guardada no Android Keystore.
 *
 * A chave nunca sai do Keystore (nem para backup, nem para outro aparelho):
 * o texto cifrado copiado para outro tablet não abre. Não usa
 * EncryptedSharedPreferences, que está obsoleto.
 *
 * Formato gravado: base64(iv) + ":" + base64(cifrado+tag).
 */
final class CofreToken {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String APELIDO = "cardapia_token_loja";
    private static final String TRANSFORMACAO = "AES/GCM/NoPadding";

    private CofreToken() {}

    private static synchronized SecretKey chave() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry existente = ks.getEntry(APELIDO, null);
        if (existente instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existente).getSecretKey();
        }
        KeyGenerator gerador = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gerador.init(new KeyGenParameterSpec.Builder(APELIDO, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gerador.generateKey();
    }

    static String cifrar(String texto) throws Exception {
        Cipher c = Cipher.getInstance(TRANSFORMACAO);
        c.init(Cipher.ENCRYPT_MODE, chave());
        byte[] cifrado = c.doFinal(texto.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cifrado, Base64.NO_WRAP);
    }

    /** Devolve null se não abrir (chave apagada, dado de outro aparelho, lixo). */
    static String decifrar(String gravado) {
        if (gravado == null) return null;
        int sep = gravado.indexOf(':');
        if (sep <= 0) return null;
        try {
            byte[] iv = Base64.decode(gravado.substring(0, sep), Base64.NO_WRAP);
            byte[] cifrado = Base64.decode(gravado.substring(sep + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance(TRANSFORMACAO);
            c.init(Cipher.DECRYPT_MODE, chave(), new GCMParameterSpec(128, iv));
            return new String(c.doFinal(cifrado), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
