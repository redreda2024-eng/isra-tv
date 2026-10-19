package com.iptvhub.androidtv;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Client WebView qui ajoute le proxy de flux natif « /__stream » devant le
 * client Capacitor standard. Toutes les autres requêtes sont transmises telles
 * quelles au comportement d'origine.
 */
public class StreamProxyWebViewClient extends BridgeWebViewClient {

    public StreamProxyWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path != null && path.equals(StreamProxy.PATH)) {
            return StreamProxy.handle(request);
        }
        return super.shouldInterceptRequest(view, request);
    }
}
