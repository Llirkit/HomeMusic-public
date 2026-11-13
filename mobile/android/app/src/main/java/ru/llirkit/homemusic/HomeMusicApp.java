package ru.llirkit.homemusic;

public final class HomeMusicApp extends android.app.Application {
  @Override
  public void onCreate() {
    super.onCreate();
    android.webkit.CookieManager.getInstance().setAcceptCookie(true);
  }
}
