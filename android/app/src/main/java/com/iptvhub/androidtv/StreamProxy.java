package com.iptvhub.androidtv;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Proxy de flux natif « /__stream ».
 *
 * Reproduit le comportement de la route /api/stream du serveur IPTV Hub (PC) :
 * lecture en continu (streaming réel), en-têtes Range, User-Agent Chrome,
 * suivi des redirections et réécriture des manifestes HLS.
 *
 * Pourquoi côté natif : le client HTTP de Capacitor (CapacitorHttp) attend la
 * réponse HTTP complète avant de la transmettre au JavaScript. Pour les flux
 * live MPEG-TS (sans fin), la lecture bloquait donc en permanence. En passant
 * par une WebResourceResponse alimentée par l'InputStream du fournisseur, les
 * octets arrivent au lecteur au fur et à mesure.
 */
final class StreamProxy {

    static final String PATH = "/__stream";

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int MAX_REDIRECTS = 3;
    private static final int MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
    private static final Pattern URI_ATTRIBUTE = Pattern.compile("URI=\"([^\"]+)\"");

    private StreamProxy() {}

    static WebResourceResponse handle(WebResourceRequest request) {
        String streamUrl = request.getUrl().getQueryParameter("url");
        if (streamUrl == null || streamUrl.isEmpty() || streamUrl.length() > 8192) {
            return jsonError(400, "URL du flux invalide.");
        }

        try {
            return proxy(request, streamUrl);
        } catch (Exception error) {
            String message = error.getMessage();
            return jsonError(502, message == null || message.isEmpty()
                    ? "Impossible de lire ce flux."
                    : message);
        }
    }

    private static WebResourceResponse proxy(WebResourceRequest request, String streamUrl) throws Exception {
        try {
            URL parsed = new URL(streamUrl);
            String protocol = parsed.getProtocol();
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                return jsonError(400, "Seules les URL HTTP(S) sont acceptées.");
            }
        } catch (Exception error) {
            return jsonError(400, "URL du flux invalide.");
        }

        String rangeHeader = request.getRequestHeaders().get("Range");
        Upstream upstream = openUpstream(streamUrl, rangeHeader);
        HttpURLConnection connection = upstream.connection;

        int status = connection.getResponseCode();
        String contentType = connection.getContentType();
        String contentTypeLower = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        String path = upstream.finalUrl.getPath() == null
                ? ""
                : upstream.finalUrl.getPath().toLowerCase(Locale.ROOT);

        boolean manifestByUrl = path.endsWith(".m3u8") || path.endsWith(".m3u");
        boolean isManifest =
                status >= 200
                        && status < 300
                        && rangeHeader == null
                        && (manifestByUrl || contentTypeLower.contains("mpegurl"));

        if (isManifest) {
            String manifest;
            try {
                manifest = readText(connection, MANIFEST_MAX_BYTES);
            } finally {
                connection.disconnect();
            }
            if (manifest == null || !manifest.trim().startsWith("#EXTM3U")) {
                return jsonError(502, "Le flux a renvoyé un manifeste HLS invalide.");
            }
            String base = request.getUrl().getScheme() + "://" + request.getUrl().getAuthority();
            String rewritten = rewriteManifest(manifest, upstream.finalUrl.toString(), base);
            return new WebResourceResponse(
                    "application/vnd.apple.mpegurl",
                    "utf-8",
                    200,
                    "OK",
                    noCacheHeaders(),
                    new ByteArrayInputStream(rewritten.getBytes(StandardCharsets.UTF_8)));
        }

        InputStream body;
        try {
            body = connection.getInputStream();
        } catch (IOException error) {
            InputStream errorStream = connection.getErrorStream();
            body = errorStream != null ? errorStream : new ByteArrayInputStream(new byte[0]);
        }
        // La fermeture du flux doit libérer la connexion HTTP : sans cela, les seeks,
        // changements de chaîne et coupures laissaient des connexions ouvertes qui
        // finissaient par saturer la pile réseau de la TV box.
        body = new FilterInputStream(body) {
            @Override
            public void close() throws IOException {
                try {
                    super.close();
                } finally {
                    connection.disconnect();
                }
            }
        };

        Map<String, String> headers = noCacheHeaders();
        copyHeader(connection, headers, "Content-Type");
        copyHeader(connection, headers, "Content-Length");
        copyHeader(connection, headers, "Content-Range");
        copyHeader(connection, headers, "Accept-Ranges");
        copyHeader(connection, headers, "Last-Modified");

        String mimeType = contentType == null || contentType.isEmpty() ? guessMimeType(path) : contentType;
        String reason = connection.getResponseMessage();
        if (reason == null || reason.isEmpty()) {
            reason = status >= 200 && status < 300 ? "OK" : "Error";
        }
        return new WebResourceResponse(mimeType, null, status, reason, headers, body);
    }

    private static final class Upstream {
        final HttpURLConnection connection;
        final URL finalUrl;

        Upstream(HttpURLConnection connection, URL finalUrl) {
            this.connection = connection;
            this.finalUrl = finalUrl;
        }
    }

    private static Upstream openUpstream(String streamUrl, String rangeHeader) throws Exception {
        URL current = new URL(streamUrl);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            // Aucun délai de lecture : un flux live reste ouvert indéfiniment.
            connection.setReadTimeout(0);
            connection.setRequestProperty("Accept", "*/*");
            connection.setRequestProperty("User-Agent", USER_AGENT);
            if (rangeHeader != null) {
                connection.setRequestProperty("Range", rangeHeader);
            }

            int status = connection.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || location.isEmpty() || redirect == MAX_REDIRECTS) {
                    throw new IOException("Trop de redirections lors de la récupération du flux.");
                }
                current = new URL(current, location);
                continue;
            }
            return new Upstream(connection, current);
        }
        throw new IOException("Impossible de suivre la redirection du flux.");
    }

    private static String rewriteManifest(String manifest, String manifestUrl, String base) {
        String[] lines = manifest.split("\r?\n", -1);
        StringBuilder output = new StringBuilder(manifest.length() + 256);
        for (int index = 0; index < lines.length; index += 1) {
            if (index > 0) output.append('\n');
            String line = lines[index];
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                output.append(line);
                continue;
            }
            if (trimmed.startsWith("#")) {
                Matcher matcher = URI_ATTRIBUTE.matcher(line);
                StringBuffer buffer = new StringBuffer();
                while (matcher.find()) {
                    String resolved = resolveUrl(manifestUrl, matcher.group(1));
                    String proxyUrl = createProxyUrl(base, resolved);
                    matcher.appendReplacement(buffer, Matcher.quoteReplacement("URI=\"" + proxyUrl + "\""));
                }
                matcher.appendTail(buffer);
                output.append(buffer);
                continue;
            }
            output.append(createProxyUrl(base, resolveUrl(manifestUrl, trimmed)));
        }
        return output.toString();
    }

    private static String resolveUrl(String baseUrl, String relative) {
        try {
            return new URL(new URL(baseUrl), relative).toString();
        } catch (Exception error) {
            return relative;
        }
    }

    private static String createProxyUrl(String base, String streamUrl) {
        try {
            return base + PATH + "?url=" + URLEncoder.encode(streamUrl, "UTF-8");
        } catch (Exception error) {
            return streamUrl;
        }
    }

    private static String readText(HttpURLConnection connection, int maxBytes) throws IOException {
        InputStream input = connection.getInputStream();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new IOException("Le manifeste vidéo dépasse la taille maximale autorisée.");
            }
            output.write(buffer, 0, read);
        }
        return output.toString("UTF-8");
    }

    private static void copyHeader(HttpURLConnection connection, Map<String, String> headers, String name) {
        String value = connection.getHeaderField(name);
        if (value != null && !value.isEmpty()) {
            headers.put(name, value);
        }
    }

    private static Map<String, String> noCacheHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }

    private static String guessMimeType(String path) {
        if (path.endsWith(".ts") || path.endsWith(".m2ts")) return "video/mp2t";
        if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "application/vnd.apple.mpegurl";
        if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
        if (path.endsWith(".webm")) return "video/webm";
        if (path.endsWith(".mp3")) return "audio/mpeg";
        if (path.endsWith(".aac")) return "audio/aac";
        return "application/octet-stream";
    }

    private static WebResourceResponse jsonError(int status, String message) {
        String body = "{\"error\":" + quoteJson(message) + "}";
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(
                "application/json",
                "utf-8",
                status,
                status == 400 ? "Bad Request" : "Bad Gateway",
                headers,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static String quoteJson(String value) {
        StringBuilder builder = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
            }
        }
        return builder.append('"').toString();
    }
}
