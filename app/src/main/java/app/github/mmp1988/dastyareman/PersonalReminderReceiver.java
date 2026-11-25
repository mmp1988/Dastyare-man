package app.github.mmp1988.dastyareman;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

public class PersonalReminderReceiver extends BroadcastReceiver {
    private static final String PREFS = "personal_reminder_alarms";
    private static final String ITEMS = "items";
    private static final String ACTION_REMINDER = "app.github.mmp1988.dastyareman.PERSONAL_REMINDER";
    private static final String CHANNEL = "dastyare_personal_reminders_v1";

    public static String schedule(Context context, String id, long atMillis, String message) {
        if (id == null || id.trim().isEmpty() || atMillis <= System.currentTimeMillis()) return "failed";
        try {
            JSONArray old = readItems(context);
            JSONArray next = new JSONArray();
            for (int i = 0; i < old.length(); i++) {
                JSONObject item = old.optJSONObject(i);
                if (item != null && !id.equals(item.optString("id"))) next.put(item);
            }
            JSONObject item = new JSONObject();
            item.put("id", id);
            item.put("at", atMillis);
            item.put("message", message == null ? "" : message);
            next.put(item);
            android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            java.util.Set<String> fired = new java.util.HashSet<>(prefs.getStringSet("fired", new java.util.HashSet<>()));
            fired.remove(id);
            prefs.edit().putString(ITEMS, next.toString()).putStringSet("fired", fired).apply();
            return scheduleSystemAlarm(context, id, atMillis, message);
        } catch (Exception ignored) { return "failed"; }
    }

    public static void cancel(Context context, String id) {
        if (id == null) return;
        cancelSystemAlarm(context, id);
        try {
            JSONArray old = readItems(context);
            JSONArray next = new JSONArray();
            for (int i = 0; i < old.length(); i++) {
                JSONObject item = old.optJSONObject(i);
                if (item != null && !id.equals(item.optString("id"))) next.put(item);
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ITEMS, next.toString()).apply();
        } catch (Exception ignored) { }
    }

    public static boolean wasFired(Context context, String id) {
        if (id == null) return false;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("fired", new java.util.HashSet<>()).contains(id);
    }

    private static JSONArray readItems(Context context) {
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ITEMS, "[]");
            return new JSONArray(raw);
        } catch (Exception e) { return new JSONArray(); }
    }

    private static PendingIntent pendingIntent(Context context, String id, String message) {
        Intent intent = new Intent(context, PersonalReminderReceiver.class);
        intent.setAction(ACTION_REMINDER);
        intent.putExtra("id", id);
        intent.putExtra("message", message == null ? "" : message);
        int request = id.hashCode();
        return PendingIntent.getBroadcast(context, request, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String scheduleSystemAlarm(Context context, String id, long atMillis, String message) {
        try {
            AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (manager == null) return "failed";
            PendingIntent pending = pendingIntent(context, id, message);
            if (Build.VERSION.SDK_INT >= 23) {
                try {
                    manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending);
                    return "exact";
                } catch (SecurityException exactNotAllowed) {
                    // Android may deny exact alarms unless the user grants special access.
                    // Keep a real system reminder rather than silently dropping the request.
                    manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending);
                    return "approximate";
                }
            } else if (Build.VERSION.SDK_INT >= 19) {
                manager.setExact(AlarmManager.RTC_WAKEUP, atMillis, pending);
                return "exact";
            } else {
                manager.set(AlarmManager.RTC_WAKEUP, atMillis, pending);
                return "approximate";
            }
        } catch (Exception ignored) { return "failed"; }
    }

    private static void cancelSystemAlarm(Context context, String id) {
        try {
            AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (manager != null) manager.cancel(pendingIntent(context, id, ""));
        } catch (Exception ignored) { }
    }

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            JSONArray items = readItems(context);
            long now = System.currentTimeMillis();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                String id = item.optString("id", "");
                long at = item.optLong("at", 0L);
                if (!id.isEmpty() && at > now) scheduleSystemAlarm(context, id, at, item.optString("message", ""));
            }
            return;
        }
        if (!ACTION_REMINDER.equals(intent.getAction())) return;
        String id = intent.getStringExtra("id");
        String message = intent.getStringExtra("message");
        if (id == null) return;
        android.content.SharedPreferences firedPrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        java.util.Set<String> firedIds = new java.util.HashSet<>(firedPrefs.getStringSet("fired", new java.util.HashSet<>()));
        firedIds.add(id);
        firedPrefs.edit().putStringSet("fired", firedIds).apply();
        cancel(context, id);
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
                android.net.Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                AudioAttributes audio = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
                NotificationChannel channel = new NotificationChannel(CHANNEL, "هشدارهای شخصی", NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("یادآوری کارهای شخصی در زمان تعیین‌شده");
                channel.setSound(sound, audio);
                channel.enableVibration(true);
                manager.createNotificationChannel(channel);
            }
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent open = PendingIntent.getActivity(context, id.hashCode(), launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String body = message == null || message.trim().isEmpty() ? "زمان یادآوری رسیده است." : message;
            NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle("دستیار من — یادآوری شخصی")
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setAutoCancel(true)
                    .setContentIntent(open);
            manager.notify(id.hashCode(), notification.build());
        } catch (Exception ignored) { }
    }
}
