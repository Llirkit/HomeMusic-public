package ru.llirkit.homemusic;

import android.media.audiofx.Equalizer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Personal sound settings for the public broadcast, attached to its audio session. */
final class RadioEqualizer {
  private static final double[] FREQUENCIES = {60, 230, 910, 3600, 14000};
  private final double[] gains = new double[5];
  private Equalizer effect;
  private int session;
  private boolean enabled;
  private boolean supported = true;

  void settings(JSONObject message) {
    enabled = message.optBoolean("eq_enabled", false);
    JSONArray values = message.optJSONArray("eq_gains");
    for (int i = 0; i < gains.length; i++) {
      double value = values == null ? 0 : values.optDouble(i, 0);
      gains[i] = Double.isFinite(value) ? Math.max(-12, Math.min(12, value)) : 0;
    }
    apply();
  }

  void attach(int id) {
    if (id <= 0 || id == session) return;
    release();
    session = id;
    try { effect = new Equalizer(0, id); supported = true; apply(); }
    catch (RuntimeException e) { supported = false; release(); }
  }

  private void apply() {
    if (effect == null) return;
    try {
      short[] range = effect.getBandLevelRange();
      for (short band = 0; band < effect.getNumberOfBands(); band++) {
        double frequency = effect.getCenterFreq(band) / 1000d;
        int nearest = 0;
        for (int i = 1; i < gains.length; i++)
          if (Math.abs(Math.log(frequency / FREQUENCIES[i])) < Math.abs(Math.log(frequency / FREQUENCIES[nearest]))) nearest = i;
        effect.setBandLevel(band, (short) Math.max(range[0], Math.min(range[1], Math.round(gains[nearest] * 100))));
      }
      effect.setEnabled(enabled);
    } catch (RuntimeException e) { supported = false; release(); }
  }

  float headroom() {
    double boost = 0;
    if (enabled && supported) for (double gain : gains) boost = Math.max(boost, gain);
    return (float) Math.pow(10, -boost / 20);
  }
  boolean supported() { return supported; }
  void release() {
    if (effect != null) { try { effect.release(); } catch (RuntimeException ignored) { } }
    effect = null; session = 0;
  }
}
