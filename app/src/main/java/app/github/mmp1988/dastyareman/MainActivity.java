package app.github.mmp1988.dastyareman;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
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
import java.util.ArrayList;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQUEST_MEDIA_PERMISSION = 701;
    private static final int REQUEST_FILE = 703;
    private static final int REQUEST_EXPORT_BACKUP = 704;
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String UPDATE_URL = "https://raw.githubusercontent.com/mmp1988/Dastyare-man/main/index.html";

    private WebView webView;
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingExportJson;
    private String[] pendingAndroidPermissions;
    private String pendingNativeSpeechTarget;
    private String pendingNativeSpeechButton;
    private SpeechRecognizer nativeSpeechRecognizer;
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
        settings.setGeolocationEnabled(false);
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
        try {
            long installedVersion;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                installedVersion = getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            } else {
                installedVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            }
            android.content.SharedPreferences prefs = getSharedPreferences("app_bundle", MODE_PRIVATE);
            long bundledVersion = prefs.getLong("bundled_assets_version", -1L);

            // WebView content lives in app-private storage and survives APK upgrades.
            // Refresh bundled HTML only when the installed APK version changes, while
            // preserving newer in-app downloaded updates during normal launches.
            if (!index.exists() || bundledVersion != installedVersion) {
                copyAssetAtomically("index.html", index);
                copyAssetIfPresent("manifest.json", new File(content, "manifest.json"));
                copyAssetIfPresent("icon-192.png", new File(content, "icon-192.png"));
                copyAssetIfPresent("icon-512.png", new File(content, "icon-512.png"));
                prefs.edit().putLong("bundled_assets_version", installedVersion).apply();
            }
        } catch (Exception e) {
            Toast.makeText(this, "فایل‌های برنامه آماده نشدند", Toast.LENGTH_LONG).show();
        }
    }

    private void copyAssetAtomically(String name, File target) throws Exception {
        File temp = new File(target.getParentFile(), target.getName() + ".new");
        try (InputStream in = getAssets().open(name); FileOutputStream out = new FileOutputStream(temp)) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            out.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new Exception("Cannot replace " + target.getName());
        if (!temp.renameTo(target)) throw new Exception("Cannot install " + target.getName());
    }

    private void copyAssetIfPresent(String name, File target) {
        try (InputStream in = getAssets().open(name); FileOutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        } catch (Exception ignored) { }
    }

    private void handleWebPermission(PermissionRequest request) {
        String[] resources = request.getResources();
        boolean audioRequested = false;
        for (String resource : resources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audioRequested = true;
            else { request.deny(); return; }
        }
        if (!audioRequested) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }
        pendingWebPermission = request;
        pendingAndroidPermissions = new String[]{Manifest.permission.RECORD_AUDIO};
        requestPermissions(pendingAndroidPermissions, REQUEST_MEDIA_PERMISSION);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_MEDIA_PERMISSION && pendingNativeSpeechTarget != null) {
            String target = pendingNativeSpeechTarget;
            String button = pendingNativeSpeechButton;
            pendingNativeSpeechTarget = null;
            pendingNativeSpeechButton = null;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                startNativeSpeechOnUi(target, button);
            } else {
                notifyVoiceButton(button, false);
                notifyVoiceMessage("برای استفاده از میکروفون باید مجوز آن را بدهید؛ یا متن را تایپ کنید.");
            }
            return;
        }
        if (requestCode == REQUEST_MEDIA_PERMISSION && pendingWebPermission != null) {
            boolean granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (granted) pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingWebPermission.deny();
            pendingWebPermission = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE && fileChooserCallback != null) {
            Uri[] result = resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null;
            fileChooserCallback.onReceiveValue(result); fileChooserCallback = null;
        } else if (requestCode == REQUEST_EXPORT_BACKUP) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExportJson != null) {
                try (java.io.OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    if (out != null) {
                        out.write(pendingExportJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        Toast.makeText(this, "فایل پشتیبان در محل انتخاب‌شده ذخیره شد", Toast.LENGTH_LONG).show();
                    }
                } catch (Exception e) {
                    Toast.makeText(this, "ذخیره فایل پشتیبان ناموفق بود", Toast.LENGTH_LONG).show();
                }
            }
            pendingExportJson = null;
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
        File old = new File(target.getParentFile(), target.getName() + ".old");
        if (old.exists()) old.delete();
        if (target.exists() && !target.renameTo(old)) throw new Exception("Cannot stage previous backup");
        if (!temp.renameTo(target)) {
            if (old.exists()) old.renameTo(target);
            throw new Exception("Cannot finalize backup");
        }
        if (old.exists()) old.delete();
    }

    private void notifyVoiceButton(String buttonId, boolean active) {
        if (webView == null || buttonId == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "if(window.setVoiceButtonState)window.setVoiceButtonState(" + JSONObject.quote(buttonId) + "," + active + ");", null));
    }

    private void notifyVoiceMessage(String message) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "if(window.showToast)window.showToast(" + JSONObject.quote(message) + ");", null));
    }

    private void startNativeSpeechOnUi(String targetInputId, String buttonId) {
        if (android.os.Build.VERSION.SDK_INT < 31) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("تشخیص گفتار آفلاین در نسخه اندروید این گوشی پشتیبانی نمی‌شود؛ لطفاً تایپ کنید.");
            return;
        }
        if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("موتور گفتار آفلاین روی این گوشی موجود نیست؛ لطفاً متن را تایپ کنید.");
            return;
        }
        try {
            if (nativeSpeechRecognizer != null) {
                nativeSpeechRecognizer.destroy();
                nativeSpeechRecognizer = null;
            }
            nativeSpeechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            nativeSpeechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) {
                    notifyVoiceButton(buttonId, false);
                    String message = (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                            || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)
                            ? "بسته زبان فارسی آفلاین روی گوشی موجود نیست؛ لطفاً تایپ کنید."
                            : "تشخیص گفتار آفلاین انجام نشد؛ لطفاً دوباره تلاش کنید یا تایپ کنید.";
                    notifyVoiceMessage(message);
                    releaseNativeSpeechRecognizer();
                }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> matches = results == null ? null
                            : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (matches != null && !matches.isEmpty()) {
                        String transcript = matches.get(0);
                        if (webView != null) webView.post(() -> webView.evaluateJavascript(
                                "if(window.receiveNativeSpeechResult)window.receiveNativeSpeechResult("
                                        + JSONObject.quote(targetInputId) + "," + JSONObject.quote(transcript) + ");", null));
                    } else {
                        notifyVoiceMessage("صدایی تشخیص داده نشد؛ می‌توانید متن را تایپ کنید.");
                    }
                }
                @Override public void onPartialResults(Bundle partialResults) { }
                @Override public void onEvent(int eventType, Bundle params) { }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fa-IR");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "fa-IR");
            intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, false);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            nativeSpeechRecognizer.startListening(intent);
        } catch (Exception e) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("تشخیص گفتار آفلاین در این گوشی فعال نشد؛ لطفاً تایپ کنید.");
            releaseNativeSpeechRecognizer();
        }
    }

    private void releaseNativeSpeechRecognizer() {
        if (nativeSpeechRecognizer != null) {
            try { nativeSpeechRecognizer.destroy(); } catch (Exception ignored) { }
            nativeSpeechRecognizer = null;
        }
    }

    private class AppBridge {
        @JavascriptInterface public void startOfflineSpeechRecognition(String targetInputId, String buttonId) {
            runOnUiThread(() -> {
                if (!("apptClientName".equals(targetInputId) || "apptService".equals(targetInputId)
                        || "noteTitleInput".equals(targetInputId) || "noteBodyInput".equals(targetInputId))) {
                    notifyVoiceButton(buttonId, false);
                    notifyVoiceMessage("فیلد انتخاب‌شده معتبر نیست.");
                    return;
                }
                if (android.os.Build.VERSION.SDK_INT < 31) {
                    notifyVoiceButton(buttonId, false);
                    notifyVoiceMessage("تشخیص گفتار آفلاین در این نسخه اندروید پشتیبانی نمی‌شود؛ لطفاً تایپ کنید.");
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingNativeSpeechTarget = targetInputId;
                    pendingNativeSpeechButton = buttonId;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MEDIA_PERMISSION);
                    return;
                }
                startNativeSpeechOnUi(targetInputId, buttonId);
            });
        }

        @JavascriptInterface public void shareText(String title, String text) {
            if (text == null || text.trim().isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.setType("text/plain");
                    sendIntent.putExtra(Intent.EXTRA_SUBJECT, title == null ? "دستیار من" : title);
                    sendIntent.putExtra(Intent.EXTRA_TEXT, text);
                    Intent chooser = Intent.createChooser(sendIntent, "ارسال با...");
                    startActivity(chooser);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "اشتراک‌گذاری در این دستگاه در دسترس نیست", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface public void saveBackup(String json, String filename) {
            saveBackupInternal(json, filename);
        }
        @JavascriptInterface public void exportBackup(String json, String filename) {
            if (json == null || json.length() > 20_000_000) return;
            runOnUiThread(() -> {
                pendingExportJson = json;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, filename == null ? "dastyare-man-backup.json" : filename);
                startActivityForResult(intent, REQUEST_EXPORT_BACKUP);
            });
        }
        @JavascriptInterface public void backupData(String json) {
            saveBackupInternal(json, null);
        }
        @JavascriptInterface public String getLatestBackup() {
            try {
                File backup = new File(new File(getFilesDir(), "backups"), "latest-backup.json");
                if (!backup.exists()) return "";
                try (InputStream in = new java.io.FileInputStream(backup);
                     ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192]; int n;
                    while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                    return out.toString("UTF-8");
                }
            } catch (Exception e) { return ""; }
        }
        @JavascriptInterface public void updateApp() {
            io.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    android.content.SharedPreferences prefs = getSharedPreferences("content_updates", MODE_PRIVATE);
                    long lastSuccess = prefs.getLong("last_success_ms", 0L);
                    // Check at most every six hours after a successful connection; failed/offline checks are retried.
                    if (System.currentTimeMillis() - lastSuccess < 6L * 60L * 60L * 1000L) return;

                    connection = (HttpURLConnection)new URL(UPDATE_URL).openConnection();
                    connection.setConnectTimeout(4500);
                    connection.setReadTimeout(6500);
                    connection.setRequestProperty("Cache-Control", "no-cache");
                    connection.setRequestProperty("Pragma", "no-cache");
                    if (connection.getResponseCode() != 200) return;

                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream in = new BufferedInputStream(connection.getInputStream())) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) > 0) bytes.write(buffer, 0, n);
                    }
                    String html = bytes.toString("UTF-8");
                    if (!html.toLowerCase(Locale.ROOT).contains("<html") || !html.contains("STORAGE_KEY")) return;

                    File dir = new File(getFilesDir(), "content"); dir.mkdirs();
                    File current = new File(dir, "index.html");
                    boolean unchanged = false;
                    if (current.exists() && current.length() == bytes.size()) {
                        try (InputStream old = new java.io.FileInputStream(current);
                             ByteArrayOutputStream oldBytes = new ByteArrayOutputStream()) {
                            byte[] buffer = new byte[8192]; int n;
                            while ((n = old.read(buffer)) > 0) oldBytes.write(buffer, 0, n);
                            unchanged = java.util.Arrays.equals(oldBytes.toByteArray(), bytes.toByteArray());
                        }
                    }
                    prefs.edit().putLong("last_success_ms", System.currentTimeMillis()).apply();
                    if (unchanged) return;

                    File temp = new File(dir, "index.html.new");
                    try (FileOutputStream out = new FileOutputStream(temp)) {
                        out.write(bytes.toByteArray()); out.getFD().sync();
                    }
                    File previous = new File(dir, "index.html.previous");
                    if (current.exists()) {
                        if (previous.exists()) previous.delete();
                        if (!current.renameTo(previous)) throw new Exception("Cannot stage current app page");
                    }
                    if (!temp.renameTo(current)) {
                        if (previous.exists()) previous.renameTo(current);
                        throw new Exception("Atomic update failed");
                    }
                    runOnUiThread(() -> {
                        Toast.makeText(MainActivity.this, "بخش‌های جدید دریافت شد؛ اطلاعات ذخیره‌شده حفظ شد", Toast.LENGTH_LONG).show();
                        if (webView != null) webView.loadUrl(APP_ORIGIN + "/content/index.html");
                    });
                } catch (Exception ignored) {
                    // No network, blocked GitHub, or invalid response: keep running the installed offline copy.
                } finally {
                    if (connection != null) connection.disconnect();
                }
            });
        }
    }

    @Override protected void onPause() {
        if (webView != null) webView.evaluateJavascript("(function(){try{if(typeof appData!=='undefined'&&window.AndroidApp){AndroidApp.backupData(JSON.stringify(appData));}}catch(e){}})();", null);
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        releaseNativeSpeechRecognizer();
        if (webView != null) { webView.destroy(); webView = null; }
        io.shutdown();
        super.onDestroy();
    }
}
