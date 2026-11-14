package com.example.mediahub;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Media Hub for Fire TV and Android TV: a full-screen page that opens the hub running on the
 * Pi. Every remote key is handed to the page as its raw Android key code, which the hub's
 * keymap.js already maps (the Fire TV menu key becomes the hub's "menu" colour key). All the
 * logic lives on the Pi, so this app never needs updating when the hub changes.
 *
 * Hold Back for a second to leave the app. If the hub can't be reached, a plain page says so;
 * Select retries and Back leaves.
 */
public class MainActivity extends Activity {
    private FrameLayout root;
    private WebView web;
    private View fullscreenView;                       // HTML5 fullscreen video, when a page asks for it
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean hubLoaded;                         // true once the hub's page is showing
    private String hubUrl;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hubUrl = getString(R.string.hub_url);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                if (url != null && url.startsWith(hubUrl)) hubLoaded = true;
            }
            // Android 6 and up
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showUnreachable();
            }
            // Fire OS 5 (Android 5.1) still calls the old one
            @SuppressWarnings("deprecation")
            @Override public void onReceivedError(WebView v, int code, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(hubUrl)) showUnreachable();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback cb) {
                if (fullscreenView != null) { cb.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = cb;
                web.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            @Override public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                web.setVisibility(View.VISIBLE);
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                fullscreenCallback = null;
            }
        });

        hideSystemUi();
        web.requestFocus();
        web.loadUrl(hubUrl);
    }

    /** Remote keys never reach the page natively; they are re-sent as the hub's key codes. */
    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        boolean up = e.getAction() == KeyEvent.ACTION_UP;

        if (code == KeyEvent.KEYCODE_BACK) {
            if (down && e.getRepeatCount() == 0) e.startTracking();
            if (down && e.isLongPress()) { finish(); return true; }       // hold Back: leave the app
            if (!hubLoaded) { if (up && !e.isCanceled()) finish(); return true; }
        }
        if (!hubLoaded) {                                                  // the "can't reach" page
            if (up && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)) web.loadUrl(hubUrl);
            return true;
        }

        int sent = translate(code);
        if (sent < 0) return super.dispatchKeyEvent(e);                    // volume, mute, anything else: the TV's
        if (down) inject("keydown", sent, e.getRepeatCount() > 0);
        else if (up) inject("keyup", sent, false);
        return true;
    }

    /** The hub's android key map uses raw Android key codes. Keys Fire TV remotes lack get stand-ins. */
    private static int translate(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT: case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BACK: case KeyEvent.KEYCODE_ESCAPE:
            case KeyEvent.KEYCODE_MEDIA_PLAY: case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_NEXT: case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_PROG_RED: case KeyEvent.KEYCODE_PROG_GREEN: case KeyEvent.KEYCODE_PROG_YELLOW:
                return code;
            case KeyEvent.KEYCODE_MENU:            return KeyEvent.KEYCODE_PROG_GREEN;   // the hub's "menu" key
            case KeyEvent.KEYCODE_MEDIA_STOP:      return KeyEvent.KEYCODE_MEDIA_PAUSE;
            case KeyEvent.KEYCODE_BUTTON_A:        return KeyEvent.KEYCODE_DPAD_CENTER;  // game controllers
            case KeyEvent.KEYCODE_BUTTON_B:        return KeyEvent.KEYCODE_BACK;
            default:                               return -1;
        }
    }

    private void inject(String type, int code, boolean repeat) {
        String js = "(function(){var c=" + code + ";"
            + "var e=new KeyboardEvent('" + type + "',{bubbles:true,cancelable:true,keyCode:c,which:c,repeat:" + repeat + "});"
            + "try{Object.defineProperty(e,'keyCode',{get:function(){return c}});"
            + "Object.defineProperty(e,'which',{get:function(){return c}})}catch(x){}"
            + "window.dispatchEvent(e)})()";
        web.evaluateJavascript(js, null);
    }

    private void showUnreachable() {
        hubLoaded = false;
        String html = "<!doctype html><html><body style='margin:0;background:#000;color:#eee;font:32px sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'><div>"
            + "<p style='font-size:44px;margin:0 0 24px'>Can't reach the hub</p>"
            + "<p style='margin:0 0 12px'>Tried " + hubUrl + "</p>"
            + "<p style='margin:0 0 36px;color:#aaa'>Check the Pi is on and plugged into the router.</p>"
            + "<p style='margin:0;color:#aaa'>Select: try again &nbsp; Back: leave</p>"
            + "</div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override protected void onResume() { super.onResume(); hideSystemUi(); web.onResume(); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
