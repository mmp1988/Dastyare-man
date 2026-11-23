package app.github.mmp1988.dastyareman;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.SpeechService;
import org.vosk.android.RecognitionListener;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import android.app.DownloadManager;
import android.content.Context;
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
    private Model voskModel;
    private Recognizer voskRecognizer;
    private SpeechService voskSpeechService;
    private String activeSpeechModelId;
    private volatile boolean speechModelDownloadActive = false;
    private final ExecutorService speechModelExecutor = Executors.newSingleThreadExecutor();
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

    private File speechModelsRoot() {
        File root = new File(getFilesDir(), "speech-models");
        if (!root.exists()) root.mkdirs();
        return root;
    }

    private File speechModelDirectory(String modelId) {
        if (!"small".equals(modelId) && !"large".equals(modelId)) return null;
        return new File(speechModelsRoot(), "fa-" + modelId);
    }

    private boolean isSpeechModelInstalled(String modelId) {
        File dir = speechModelDirectory(modelId);
        return dir != null && new File(dir, ".complete").isFile()
                && new File(dir, "am").isDirectory();
    }

    private void notifySpeechModelStatus(String modelId, String state, long downloaded, long total, String message) {
        if (webView == null) return;
        File dir = speechModelDirectory(modelId);
        long size = dir == null ? 0L : directorySize(dir);
        boolean installed = isSpeechModelInstalled(modelId);
        try {
            JSONObject payload = new JSONObject();
            payload.put("modelId", modelId);
            payload.put("state", state);
            payload.put("downloaded", downloaded);
            payload.put("total", total);
            payload.put("percent", total > 0 ? Math.min(100, Math.round(downloaded * 100.0 / total)) : 0);
            payload.put("installed", installed);
            payload.put("size", size);
            if (message != null) payload.put("message", message);
            String json = payload.toString();
            webView.post(() -> webView.evaluateJavascript(
                    "if(window.onSpeechModelStatus)window.onSpeechModelStatus(" + json + ");", null));
        } catch (Exception ignored) { }
    }

    private long directorySize(File file) {
        if (file == null || !file.exists()) return 0L;
        if (file.isFile()) return file.length();
        long total = 0L;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) total += directorySize(child);
        return total;
    }

    private void sendSpeechModelStatus(String modelId) {
        if (isSpeechModelInstalled(modelId)) notifySpeechModelStatus(modelId, "installed", 0L, 0L, null);
        else notifySpeechModelStatus(modelId, "not_downloaded", 0L, 0L, null);
    }

    private void downloadSpeechModel(String modelId) {
        if (!"small".equals(modelId) && !"large".equals(modelId)) return;
        if (speechModelDownloadActive) {
            notifyVoiceMessage("یک دانلود بسته گفتار در حال انجام است؛ لطفاً صبر کنید.");
            return;
        }
        if (isSpeechModelInstalled(modelId)) {
            sendSpeechModelStatus(modelId);
            return;
        }
        speechModelDownloadActive = true;
        speechModelExecutor.execute(() -> {
            File root = speechModelsRoot();
            File zip = new File(root, "fa-" + modelId + ".zip.part");
            File stage = new File(root, "fa-" + modelId + "-extracting");
            long total = "small".equals(modelId) ? 53L * 1024L * 1024L : 1600L * 1024L * 1024L;
            long downloaded = 0L;
            HttpURLConnection connection = null;
            try {
                if (stage.exists()) deleteRecursively(stage);
                if (zip.exists() && !zip.delete()) throw new Exception("Cannot clear old partial download");
                String modelFile = "small".equals(modelId) ? "vosk-model-small-fa-0.42.zip" : "vosk-model-fa-0.42.zip";
                URL url = new URL("https://alphacephei.com/vosk/models/" + modelFile);
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(45000);
                connection.setRequestProperty("User-Agent", "DastyareMan-Android");
                connection.connect();
                int response = connection.getResponseCode();
                if (response != HttpURLConnection.HTTP_OK) throw new Exception("HTTP " + response);
                long contentLength = connection.getContentLengthLong();
                if (contentLength > 0) total = contentLength;
                notifySpeechModelStatus(modelId, "downloading", 0L, total, null);
                try (InputStream in = new BufferedInputStream(connection.getInputStream());
                     FileOutputStream out = new FileOutputStream(zip)) {
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    long lastNotify = 0L;
                    while ((count = in.read(buffer)) != -1) {
                        out.write(buffer, 0, count);
                        downloaded += count;
                        if (downloaded - lastNotify >= 512L * 1024L) {
                            notifySpeechModelStatus(modelId, "downloading", downloaded, total, null);
                            lastNotify = downloaded;
                        }
                    }
                    out.getFD().sync();
                }
                if (downloaded < 1024L * 1024L) throw new Exception("Downloaded archive is too small");
                notifySpeechModelStatus(modelId, "extracting", downloaded, total, null);
                if (!stage.mkdirs() && !stage.isDirectory()) throw new Exception("Cannot create extraction folder");
                long extracted = 0L;
                try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(zip)))) {
                    ZipEntry entry;
                    byte[] buffer = new byte[32 * 1024];
                    while ((entry = zin.getNextEntry()) != null) {
                        File outFile = new File(stage, entry.getName());
                        String canonicalRoot = stage.getCanonicalPath() + File.separator;
                        if (!outFile.getCanonicalPath().startsWith(canonicalRoot)) throw new Exception("Unsafe archive path");
                        if (entry.isDirectory()) {
                            outFile.mkdirs();
                        } else {
                            File parent = outFile.getParentFile();
                            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new Exception("Cannot create model folder");
                            try (FileOutputStream out = new FileOutputStream(outFile)) {
                                int n;
                                while ((n = zin.read(buffer)) != -1) {
                                    extracted += n;
                                    long cap = "small".equals(modelId) ? 1024L*1024L*1024L : 6L*1024L*1024L*1024L;
                                    if (extracted > cap) throw new Exception("Extracted model exceeds safety limit");
                                    out.write(buffer, 0, n);
                                }
                            }
                        }
                        zin.closeEntry();
                    }
                }
                File modelRoot = null;
                File[] children = stage.listFiles();
                if (children != null) {
                    for (File child : children) {
                        if (child.isDirectory() && new File(child, "am").isDirectory()) { modelRoot = child; break; }
                    }
                }
                if (modelRoot == null) throw new Exception("Model archive layout is invalid");
                File target = speechModelDirectory(modelId);
                if (target.exists()) deleteRecursively(target);
                if (!modelRoot.renameTo(target)) throw new Exception("Cannot finalize model installation");
                File marker = new File(target, ".complete");
                try (FileOutputStream out = new FileOutputStream(marker)) {
                    out.write("vosk-fa-0.42".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                deleteRecursively(stage);
                zip.delete();
                notifySpeechModelStatus(modelId, "installed", downloaded, total, null);
            } catch (Exception e) {
                if (stage.exists()) deleteRecursively(stage);
                if (zip.exists()) zip.delete();
                notifySpeechModelStatus(modelId, "error", downloaded, total, e.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
                speechModelDownloadActive = false;
            }
        });
    }

    private void deleteSpeechModel(String modelId) {
        if (!"small".equals(modelId) && !"large".equals(modelId)) return;
        if (modelId.equals(activeSpeechModelId)) {
            notifyVoiceMessage("ابتدا گفتار را متوقف کنید و سپس بسته را حذف کنید.");
            return;
        }
        speechModelExecutor.execute(() -> {
            File dir = speechModelDirectory(modelId);
            boolean ok = dir == null || !dir.exists() || deleteRecursively(dir);
            File zip = new File(speechModelsRoot(), "fa-" + modelId + ".zip.part");
            if (zip.exists()) zip.delete();
            notifySpeechModelStatus(modelId, ok ? "not_downloaded" : "error", 0L, 0L, null);
        });
    }

    private boolean deleteRecursively(File file) {
        if (file == null || !file.exists()) return true;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) if (!deleteRecursively(child)) return false;
        }
        return file.delete();
    }

    private String extractVoskText(String json) {
        try {
            String value = new JSONObject(json).optString("text", "").trim();
            return value;
        } catch (Exception ignored) { return ""; }
    }

    private void releaseVoskSpeech() {
        try { if (voskSpeechService != null) { voskSpeechService.stop(); voskSpeechService.shutdown(); } } catch (Exception ignored) { }
        try { if (voskRecognizer != null) voskRecognizer.close(); } catch (Exception ignored) { }
        try { if (voskModel != null) voskModel.close(); } catch (Exception ignored) { }
        voskSpeechService = null;
        voskRecognizer = null;
        voskModel = null;
        activeSpeechModelId = null;
    }

    private void startVoskSpeech(String modelId, String targetInputId, String buttonId) {
        notifyVoiceMessage("موتور فارسی آفلاین در حال آماده‌سازی است…");
        speechModelExecutor.execute(() -> {
            try {
                Model model = new Model(speechModelDirectory(modelId).getAbsolutePath());
                Recognizer recognizer = new Recognizer(model, 16000.0f);
                runOnUiThread(() -> {
                    try {
                        releaseVoskSpeech();
                        voskModel = model;
                        voskRecognizer = recognizer;
                        voskSpeechService = new SpeechService(recognizer, 16000.0f);
                        activeSpeechModelId = modelId;
                        notifyVoiceButton(buttonId, true);
                        boolean started = voskSpeechService.startListening(new RecognitionListener() {
                            @Override public void onPartialResult(String hypothesis) { }
                            @Override public void onResult(String hypothesis) {
                                String text = extractVoskText(hypothesis);
                                if (!text.isEmpty() && webView != null) webView.post(() -> webView.evaluateJavascript(
                                        "if(window.receiveNativeSpeechResult)window.receiveNativeSpeechResult("
                                                + JSONObject.quote(targetInputId) + "," + JSONObject.quote(text) + ");", null));
                            }
                            @Override public void onFinalResult(String hypothesis) {
                                String text = extractVoskText(hypothesis);
                                if (!text.isEmpty() && webView != null) webView.post(() -> webView.evaluateJavascript(
                                        "if(window.receiveNativeSpeechResult)window.receiveNativeSpeechResult("
                                                + JSONObject.quote(targetInputId) + "," + JSONObject.quote(text) + ");", null));
                                finishVoskSpeech(buttonId, null);
                            }
                            @Override public void onError(Exception exception) {
                                finishVoskSpeech(buttonId, "تشخیص گفتار انجام نشد؛ دوباره تلاش کنید یا تایپ کنید.");
                            }
                            @Override public void onTimeout() {
                                try {
                                    if (voskRecognizer != null) {
                                        String finalText = extractVoskText(voskRecognizer.getFinalResult());
                                        if (!finalText.isEmpty() && webView != null) webView.post(() -> webView.evaluateJavascript(
                                                "if(window.receiveNativeSpeechResult)window.receiveNativeSpeechResult("
                                                        + JSONObject.quote(targetInputId) + "," + JSONObject.quote(finalText) + ");", null));
                                    }
                                } catch (Exception ignored) { }
                                finishVoskSpeech(buttonId, "زمان ضبط تمام شد.");
                            }
                        }, 20000);
                        if (!started) finishVoskSpeech(buttonId, "میکروفون در حال استفاده است؛ کمی بعد دوباره تلاش کنید.");
                    } catch (Exception e) {
                        try { recognizer.close(); } catch (Exception ignored) { }
                        try { model.close(); } catch (Exception ignored) { }
                        notifyVoiceButton(buttonId, false);
                        notifyVoiceMessage("راه‌اندازی موتور فارسی ممکن نشد؛ لطفاً تایپ کنید.");
                    }
                });
            } catch (OutOfMemoryError memoryError) {
                notifyVoiceButton(buttonId, false);
                notifyVoiceMessage("این بسته برای حافظه آزاد گوشی سنگین است؛ بسته سبک را نصب کنید.");
            } catch (Exception e) {
                notifyVoiceButton(buttonId, false);
                notifyVoiceMessage("باز کردن بسته گفتار ممکن نشد؛ بسته را دوباره دانلود کنید.");
            }
        });
    }

    private void finishVoskSpeech(String buttonId, String message) {
        notifyVoiceButton(buttonId, false);
        if (message != null) notifyVoiceMessage(message);
        speechModelExecutor.execute(this::releaseVoskSpeech);
    }

    private void startNativeSpeechOnUi(String targetInputId, String buttonId) {
        String modelId = isSpeechModelInstalled("small") ? "small"
                : (isSpeechModelInstalled("large") ? "large" : null);
        if (modelId != null) {
            startVoskSpeech(modelId, targetInputId, buttonId);
            return;
        }
        if (android.os.Build.VERSION.SDK_INT < 31) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("برای گفتار فارسی آفلاین، بسته را از تنظیمات و بخش شخصی‌سازی دانلود کنید؛ یا تایپ کنید.");
            return;
        }
        if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("بسته گفتار فارسی نصب نیست؛ از تنظیمات آن را دانلود کنید یا تایپ کنید.");
            return;
        }
        try {
            if (nativeSpeechRecognizer != null) {
                nativeSpeechRecognizer.destroy();
                nativeSpeechRecognizer = null;
            }
            nativeSpeechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            nativeSpeechRecognizer.setRecognitionListener(new android.speech.RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) {
                    notifyVoiceButton(buttonId, false);
                    notifyVoiceMessage("بسته زبان فارسی آفلاین گوشی موجود نیست؛ بسته فارسی را از تنظیمات دانلود کنید یا تایپ کنید.");
                    releaseNativeSpeechRecognizer();
                }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> matches = results == null ? null
                            : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (matches != null && !matches.isEmpty() && webView != null) {
                        String transcript = matches.get(0);
                        webView.post(() -> webView.evaluateJavascript(
                                "if(window.receiveNativeSpeechResult)window.receiveNativeSpeechResult("
                                        + JSONObject.quote(targetInputId) + "," + JSONObject.quote(transcript) + ");", null));
                    }
                    notifyVoiceButton(buttonId, false);
                    releaseNativeSpeechRecognizer();
                }
                @Override public void onPartialResults(Bundle partialResults) { }
                @Override public void onEvent(int eventType, Bundle params) { }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fa-IR");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "fa-IR");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            nativeSpeechRecognizer.startListening(intent);
        } catch (Exception e) {
            notifyVoiceButton(buttonId, false);
            notifyVoiceMessage("تشخیص گفتار در این گوشی فعال نشد؛ لطفاً تایپ کنید.");
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
        @JavascriptInterface public void getSpeechModelStatus() {
            speechModelExecutor.execute(() -> {
                sendSpeechModelStatus("small");
                sendSpeechModelStatus("large");
            });
        }
        @JavascriptInterface public void downloadSpeechModel(String modelId) {
            if ("small".equals(modelId) || "large".equals(modelId)) MainActivity.this.downloadSpeechModel(modelId);
        }
        @JavascriptInterface public void deleteSpeechModel(String modelId) {
            if ("small".equals(modelId) || "large".equals(modelId)) MainActivity.this.deleteSpeechModel(modelId);
        }

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
        releaseVoskSpeech();
        speechModelExecutor.shutdownNow();
        if (webView != null) { webView.destroy(); webView = null; }
        io.shutdown();
        super.onDestroy();
    }
}
