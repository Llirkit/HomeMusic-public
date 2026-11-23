package ru.llirkit.homemusic;

import static org.junit.Assert.*;
import java.io.IOException;
import org.junit.Test;

public class UpdateReleaseTest {
  private static final String HASH = "a".repeat(64);
  private static final String PATH = "/app/artifacts/apk-" + HASH + ".apk";

  @Test public void offersOnlyStrictlyNewerBuilds() throws Exception {
    UpdateRelease release = new UpdateRelease(13, "1.3.9", BuildConfig.APPLICATION_ID, 5000000, HASH, PATH, "");
    assertTrue(release.newerThan(12));
    assertFalse(release.newerThan(13));
    assertFalse(release.newerThan(14));
  }

  @Test public void rejectsOtherAppsAndUntrustedOrMutableUrls() {
    for (String path : new String[] {"https://evil.test/app.apk", "/app/latest.apk", "/app/artifacts/../latest.apk", PATH + "?x=1"})
      assertThrows(IOException.class, () -> new UpdateRelease(13, "1.3.9", BuildConfig.APPLICATION_ID, 10, HASH, path, ""));
    assertThrows(IOException.class, () -> new UpdateRelease(13, "1.3.9", "app.homemusic", 10, HASH, PATH, ""));
  }

  @Test public void rejectsInvalidSizesAndChecksums() {
    for (long size : new long[] {-1, 0, UpdateRelease.MAX_BYTES + 1})
      assertThrows(IOException.class, () -> new UpdateRelease(13, "1.3.9", BuildConfig.APPLICATION_ID, size, HASH, PATH, ""));
    assertThrows(IOException.class, () -> new UpdateRelease(13, "1.3.9", BuildConfig.APPLICATION_ID, 10, "wrong", PATH, ""));
  }
}
