package com.iptvhub.androidtv;

import android.content.Context;
import android.content.res.Configuration;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;

public class MainActivity extends BridgeActivity {
    // Durée d'appui long sur la touche Retour pour quitter l'application.
    private static final long LONG_PRESS_MS = 700;
    private long backDownTime = 0;
    private boolean backPressed = false;

    // Largeur "bureau" simulee (pixels CSS) : l'interface s'affiche comme sur Windows/web
    // au lieu de passer en mise en page mobile sur l'ecran de la TV.
    private static final float TARGET_CSS_WIDTH = 1600f;

    @Override
    protected void attachBaseContext(Context base) {
        DisplayMetrics dm = base.getResources().getDisplayMetrics();
        int longSide = Math.max(dm.widthPixels, dm.heightPixels);
        int dpi = Math.round(longSide * 160f / TARGET_CSS_WIDTH);
        dpi = Math.max(120, Math.min(640, dpi));
        Configuration config = new Configuration(base.getResources().getConfiguration());
        config.densityDpi = dpi;
        super.attachBaseContext(base.createConfigurationContext(config));
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Écran toujours allumé : utile pour une Smart TV / un boîtier Android.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemUi();
        // Proxy de flux natif : lecture continue des flux live (le client HTTP de
        // Capacitor met la réponse entière en mémoire et bloquait les flux infinis).
        try {
            getBridge().getWebView().setWebViewClient(new StreamProxyWebViewClient(getBridge()));
        } catch (Exception error) {
            Logger.error("Stream proxy client unavailable, falling back.", error);
        }
        // Passerelle JS -> natif pour quitter l'application depuis le bouton à l'écran.
        getBridge().getWebView().addJavascriptInterface(new ExitBridge(), "AndroidTv");
    }

    public class ExitBridge {
        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> finish());
        }
    }

    // La touche Retour est interceptée ici : appui court = retour dans l'application,
    // appui long = fermeture de l'application.
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (!backPressed) {
                backDownTime = System.currentTimeMillis();
                backPressed = true;
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            long held = System.currentTimeMillis() - backDownTime;
            backPressed = false;
            if (held >= LONG_PRESS_MS) {
                finish();
            } else {
                dispatchBackEvent();
            }
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    private void dispatchBackEvent() {
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('iptvhub:back'))", null));
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
        }
    }

    // Affichage plein écran immersif : la barre d'état et la barre de navigation
    // sont masquées, l'app occupe toute la surface de l'écran télé.
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
        );
    }
}
