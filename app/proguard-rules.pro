# Keep JavaScriptInterface methods accessible from WebView
-keepclassmembers class com.tvapkbuilder.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Jsoup classes
-keep class org.jsoup.** { *; }
-dontwarn org.jsoup.**
