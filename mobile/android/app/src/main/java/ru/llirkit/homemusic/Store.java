package ru.llirkit.homemusic;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import java.io.File;
import java.util.*;
import org.json.*;

final class Store extends SQLiteOpenHelper {
  static final class Song {
    String id, owner, base, sid, title, artist, state, file, mime, error;
    String lyrics;
    long bytes;
    int progress;
  }

  private final Context context;

  Store(Context c) {
    super(c, "offline.db", null, 2);
    context = c.getApplicationContext();
  }

  @Override
  public void onCreate(SQLiteDatabase db) {
    db.execSQL(
        "CREATE TABLE songs (id TEXT PRIMARY KEY,owner TEXT NOT NULL,base TEXT NOT NULL,sid TEXT"
            + " NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,state TEXT NOT NULL,file TEXT NOT"
            + " NULL,mime TEXT,bytes INTEGER NOT NULL DEFAULT 0,progress INTEGER NOT NULL DEFAULT"
            + " 0,error TEXT,added INTEGER NOT NULL,lyrics TEXT)");
  }

  @Override
  public void onUpgrade(SQLiteDatabase db, int a, int b) {
    if (a < 2) db.execSQL("ALTER TABLE songs ADD COLUMN lyrics TEXT");
  }

  static Song read(Cursor c) {
    Song s = new Song();
    s.id = c.getString(0);
    s.owner = c.getString(1);
    s.base = c.getString(2);
    s.sid = c.getString(3);
    s.title = c.getString(4);
    s.artist = c.getString(5);
    s.state = c.getString(6);
    s.file = c.getString(7);
    s.mime = c.getString(8);
    s.bytes = c.getLong(9);
    s.progress = c.getInt(10);
    s.error = c.getString(11);
    s.lyrics = c.getString(c.getColumnIndexOrThrow("lyrics"));
    return s;
  }

  List<Song> songs(String owner) {
    List<Song> out = new ArrayList<>();
    try (Cursor c =
        getReadableDatabase()
            .query(
                "songs", null, "owner=?", new String[] {owner}, null, null, "added ASC,id ASC")) {
      while (c.moveToNext()) out.add(read(c));
    }
    return out;
  }

  Song song(String id, String owner) {
    try (Cursor c = getReadableDatabase().query("songs", null, "id=? AND owner=?",
        new String[] {id, owner}, null, null, null)) {
      return c.moveToFirst() ? read(c) : null;
    }
  }

  void lyrics(Song song, String json) {
    ContentValues values = new ContentValues();
    values.put("lyrics", json);
    getWritableDatabase().update("songs", values, "id=? AND owner=?", new String[] {song.id, song.owner});
  }

  synchronized int enqueue(String owner, String base, JSONArray tracks, boolean[] selected)
      throws JSONException {
    int added = 0;
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      for (int i = 0; i < tracks.length(); i++) {
        if (!selected[i]) continue;
        JSONObject t = tracks.getJSONObject(i);
        String sid = t.optString("nd_song_id", "");
        if (sid.trim().isEmpty() || sid.equals("null")) continue;
        String id = Identity.key(owner + "\n" + sid);
        try (Cursor c =
            db.query(
                "songs",
                new String[] {"state", "file"},
                "id=?",
                new String[] {id},
                null,
                null,
                null)) {
          if (c.moveToFirst()
              && ((c.getString(0).equals("ready") && new File(c.getString(1)).isFile())
                  || c.getString(0).equals("downloading"))) continue;
        }
        File dir = new File(context.getFilesDir(), "music");
        if (!dir.isDirectory() && !dir.mkdirs())
          throw new IllegalStateException("Недоступно хранилище приложения");
        ContentValues v = new ContentValues();
        v.put("id", id);
        v.put("owner", owner);
        v.put("base", base);
        v.put("sid", sid);
        v.put("title", t.optString("title", "Без названия"));
        v.put("artist", t.optString("artist", ""));
        v.put("state", "queued");
        v.put("file", new File(dir, id + ".audio").getAbsolutePath());
        v.put("bytes", 0);
        v.put("progress", 0);
        v.put("added", System.currentTimeMillis() + i);
        db.insertWithOnConflict("songs", null, v, SQLiteDatabase.CONFLICT_REPLACE);
        added++;
      }
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
    return added;
  }

  synchronized Song claim() {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      Song s = null;
      try (Cursor c =
          db.query("songs", null, "state='queued'", null, null, null, "added ASC", "1")) {
        if (c.moveToFirst()) s = read(c);
      }
      if (s != null) {
        ContentValues v = new ContentValues();
        v.put("state", "downloading");
        v.putNull("error");
        db.update("songs", v, "id=?", new String[] {s.id});
      }
      db.setTransactionSuccessful();
      return s;
    } finally {
      db.endTransaction();
    }
  }

  synchronized void recover() {
    getWritableDatabase()
        .execSQL("UPDATE songs SET state='queued',progress=0 WHERE state='downloading'");
  }

  void progress(String id, int progress) {
    ContentValues v = new ContentValues();
    v.put("progress", progress);
    getWritableDatabase().update("songs", v, "id=?", new String[] {id});
  }

  void ready(Song s, String mime, long bytes) {
    ContentValues v = new ContentValues();
    v.put("state", "ready");
    v.put("mime", mime);
    v.put("bytes", bytes);
    v.put("progress", 100);
    v.putNull("error");
    getWritableDatabase().update("songs", v, "id=?", new String[] {s.id});
  }

  void failed(String id, String error) {
    ContentValues v = new ContentValues();
    v.put("state", "failed");
    v.put("error", error);
    getWritableDatabase().update("songs", v, "id=?", new String[] {id});
  }

  void retry(String owner) {
    ContentValues v = new ContentValues();
    v.put("state", "queued");
    v.putNull("error");
    getWritableDatabase().update("songs", v, "owner=? AND state='failed'", new String[] {owner});
  }

  void delete(Song s) throws java.io.IOException {
    File f = new File(s.file);
    if (f.exists() && !f.delete()) throw new java.io.IOException("Не удалось удалить файл");
    getWritableDatabase().delete("songs", "id=?", new String[] {s.id});
  }
}
