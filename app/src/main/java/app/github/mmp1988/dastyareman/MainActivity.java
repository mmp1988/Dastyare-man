package app.github.mmp1988.dastyareman;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.GeolocationPermissions;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQUEST_MEDIA_PERMISSION = 701;
    private static final int REQUEST_GEO_PERMISSION = 702;
    private static final int REQUEST_FILE = 703;
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String UPDATE_URL = "https://raw.githubusercontent.com/mmp1988/Dastyare-man/main/index.html";

    private WebView webView;
    private PermissionRequest pendingWebPermission;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String[] pendingAndroidPermissions;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(android.graphics.Color.rgb(11,13,18));
        getWindow().setNavigationBarColor(android.graphics.Color.rgb(11,13,18));
        ensureFoldersAndInitialContent();
        webView = new WebView(this);
        setContentView(webView);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/content/", new WebViewAssetLoader.InternalStoragePathHandler(this, new File(getFilesDir(), "content")))
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(true);
        settings.setDefaultTextEncodingName("UTF-8");
        webView.addJavascriptInterface(new AppBridge(), "AndroidApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.getHost() != null && uri.getHost().equals("appassets.androidplatform.net")) return false;
                if ("https".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                runOnUiThread(() -> handleGeoPermission(origin, callback));
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(intent, REQUEST_FILE);
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle("دستیار من");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "dastyare-man-backup.json");
                ((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            } catch (Exception e) {
                Toast.makeText(this, "ذخیره فایل انجام نشد", Toast.LENGTH_LONG).show();
            }
        });

        webView.loadUrl(APP_ORIGIN + "/content/index.html");
    }

    private void ensureFoldersAndInitialContent() {
        File content = new File(getFilesDir(), "content");
        File data = new File(getFilesDir(), "data");
        File backups = new File(getFilesDir(), "backups");
        File updates = new File(getFilesDir(), "updates");
        content.mkdirs(); data.mkdirs(); backups.mkdirs(); updates.mkdirs();
        File index = new File(content, "index.html");
        if (!index.exists()) {
            try (InputStream in = getAssets().open("index.html"); FileOutputStream out = new FileOutputStream(index)) {
                byte[] buffer = new byte[8192]; int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                copyAssetIfPresent("manifest.json", new File(content, "manifest.json"));
                copyAssetIfPresent("icon-192.png", new File(content, "icon-192.png"));
                copyAssetIfPresent("icon-512.png", new File(content, "icon-512.png"));
            } catch (Exception e) {
                Toast.makeText(this, "فایل‌های برنامه آماده نشدند", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void copyAssetIfPresent(String name, File target) {
        try (InputStream in = getAssets().open(name); FileOutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        } catch (Exception ignored) { }
    }

    private void handleWebPermission(PermissionRequest request) {
        String[] resources = request.getResources();
        java.util.ArrayList<String> needed = new java.util.ArrayList<>();
        for (String resource : resources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                needed.add(Manifest.permission.RECORD_AUDIO);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) &&
                    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
                needed.add(Manifest.permission.CAMERA);
        }
        if (needed.isEmpty()) { request.grant(resources); return; }
        pendingWebPermission = request;
        pendingAndroidPermissions = needed.toArray(new String[0]);
        requestPermissions(pendingAndroidPermissions, REQUEST_MEDIA_PERMISSION);
    }

    private void handleGeoPermission(String origin, GeolocationPermissions.Callback callback) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            callback.invoke(origin, true, false);
        } else {
            pendingGeoOrigin = origin; pendingGeoCallback = callback;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQUEST_GEO_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_MEDIA_PERMISSION && pendingWebPermission != null) {
            boolean granted = true;
            for (String permission : pendingAndroidPermissions)
                if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) pendingWebPermission.grant(pendingWebPermission.getResources());
            else pendingWebPermission.deny();
            pendingWebPermission = null;
        } else if (requestCode == REQUEST_GEO_PERMISSION && pendingGeoCallback != null) {
            boolean granted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE && fileChooserCallback != null) {
            Uri[] result = resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null;
            fileChooserCallback.onReceiveValue(result); fileChooserCallback = null;
        }
    }

    private void saveBackupInternal(String json, String requestedName) {
        if (json == null || json.length() > 20_000_000) return;
        io.execute(() -> {
            try {
                File dir = new File(getFilesDir(), "backups"); dir.mkdirs();
                String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
                writeAtomic(new File(dir, "latest-backup.json"), json);
                writeAtomic(new File(dir, "backup-" + day + ".json"), json);
                if (requestedName != null && requestedName.endsWith(".json"))
                    writeAtomic(new File(dir, requestedName.replaceAll("[^a-zA-Z0-9._-]", "_")), json);
            } catch (Exception ignored) { }
        });
    }

    private void writeAtomic(File target, String content) throws Exception {
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8)); out.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new Exception("Cannot replace backup");
        if (!temp.renameTo(target)) throw new Exception("Cannot finalize backup");
    }

    private class AppBridge {
        @JavascriptInterface public void saveBackup(String json, String filename) {
            saveBackupInternal(json, filename);
        }
        @JavascriptInterface public void backupData(String json) {
            saveBackupInternal(json, null);
        }
        @JavascriptInterface public void updateApp() {
            io.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection)new URL(UPDATE_URL).openConnection();
                    connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
                    connection.setRequestProperty("Cache-Control", "no-cache");
                    if (connection.getResponseCode() != 200) throw new Exception("HTTP " + connection.getResponseCode());
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream in = new BufferedInputStream(connection.getInputStream())) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) > 0) bytes.write(buffer, 0, n);
                    }
                    String html = bytes.toString("UTF-8");
                    if (!html.contains("<html") || !html.contains("STORAGE_KEY")) throw new Exception("Invalid app bundle");
                    File dir = new File(getFilesDir(), "content"); dir.mkdirs();
                    File temp = new File(dir, "index.html.new");
                    try (FileOutputStream out = new FileOutputStream(temp)) {
                        out.write(bytes.toByteArray()); out.getFD().sync();
                    }
                    File current = new File(dir, "index.html");
                    File previous = new File(dir, "index.html.previous");
                    if (current.exists()) {
                        if (previous.exists()) previous.delete();
                        current.renameTo(previous);
                    }
                    if (!temp.renameTo(current)) {
                        if (previous.exists()) previous.renameTo(current);
                        throw new Exception("Atomic update failed");
                    }
                    runOnUiThread(() -> {
                        Toast.makeText(MainActivity.this, "به‌روزرسانی دریافت شد؛ اطلاعات شما حفظ شده است", Toast.LENGTH_LONG).show();
                        webView.loadUrl(APP_ORIGIN + "/content/index.html");
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "به‌روزرسانی انجام نشد؛ اطلاعات فعلی دست‌نخورده ماند", Toast.LENGTH_LONG).show());
                } finally { if (connection != null) connection.disconnect(); }
            });
        }
    }

    @Override protected void onPause() {
        if (webView != null) webView.evaluateJavascript("(function(){try{if(window.appData&&window.AndroidApp){AndroidApp.backupData(JSON.stringify(window.appData));}}catch(e){}})();", null);
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (webView != null) { webView.destroy(); webView = null; }
        io.shutdown();
        super.onDestroy();
    }
}
