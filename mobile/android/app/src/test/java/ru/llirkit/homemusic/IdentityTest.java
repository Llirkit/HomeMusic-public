package ru.llirkit.homemusic;

import static org.junit.Assert.*;

import org.junit.Test;

public class IdentityTest {
  @Test
  public void acceptsHttpsOrigin() {
    assertEquals("https://spotik.llirkit.ru", Identity.origin("https://spotik.llirkit.ru/"));
  }

  @Test
  public void rejectsUnsafeServerAddresses() {
    for (String s :
        new String[] {
          "http://spotik.llirkit.ru",
          "https://user:password@spotik.llirkit.ru",
          "https://spotik.llirkit.ru/path",
          "javascript:alert(1)",
          "https://spotik.llirkit.ru?x=1"
        }) {
      try {
        Identity.origin(s);
        fail(s);
      } catch (IllegalArgumentException expected) {
      }
    }
  }

  @Test
  public void cookiesNeverFollowCrossOriginRedirects() {
    assertTrue(
        Identity.sameOrigin("https://spotik.llirkit.ru", "https://spotik.llirkit.ru:443/api"));
    assertFalse(
        Identity.sameOrigin(
            "https://spotik.llirkit.ru", "https://spotik.llirkit.ru.attacker.test"));
    assertFalse(Identity.sameOrigin("https://spotik.llirkit.ru", "http://spotik.llirkit.ru"));
    assertFalse(Identity.sameOrigin("https://spotik.llirkit.ru", "https://spotik.llirkit.ru:444"));
  }

  @Test
  public void accountFilesHaveSeparateSafeNames() {
    assertNotEquals(Identity.key("server|1\nsong"), Identity.key("server|2\nsong"));
    assertTrue(Identity.key("../../secret").matches("[a-f0-9]{64}"));
  }
}
