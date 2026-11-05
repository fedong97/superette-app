package cm.fedonix.inventaire;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;

/**
 * Démarre Firebase avec les réglages envoyés par le serveur du magasin
 * (google-services.json collé sur la page Téléphones) : la même appli sert
 * tous les magasins, sans être recompilée pour chacun.
 */
@CapacitorPlugin(name = "FirebaseSetup")
public class FirebaseSetupPlugin extends Plugin {

    @PluginMethod
    public void init(PluginCall call) {
        try {
            createChannel();
            if (FirebaseApp.getApps(getContext()).isEmpty()) {
                String appId = call.getString("appId");
                String apiKey = call.getString("apiKey");
                String projectId = call.getString("projectId");
                String senderId = call.getString("senderId");
                if (appId == null || apiKey == null || projectId == null || senderId == null) {
                    call.reject("Réglages Firebase incomplets");
                    return;
                }
                FirebaseOptions options = new FirebaseOptions.Builder()
                    .setApplicationId(appId)
                    .setApiKey(apiKey)
                    .setProjectId(projectId)
                    .setGcmSenderId(senderId)
                    .build();
                FirebaseApp.initializeApp(getContext(), options);
            }
            JSObject ret = new JSObject();
            ret.put("ready", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Canal « Alertes du magasin » : son et bandeau, même téléphone verrouillé. */
    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel("alertes") != null) return;
        NotificationChannel ch = new NotificationChannel("alertes", "Alertes du magasin", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Demandes d'accord, demandes à valider, écarts de caisse, remises, annulations");
        nm.createNotificationChannel(ch);
    }
}
