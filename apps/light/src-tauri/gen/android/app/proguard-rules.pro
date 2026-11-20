# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# HAND-EDITED: the page's immersive bridge (`MainActivity.kt`'s `ImmersiveBridge`, added to the
# WebView as `grimoireImmersive`). The WebView finds `setImmersive` by its name and its annotation
# at run time, so a release build's R8 must neither rename nor drop it, nor strip the annotation.
# `apps/light/host.test.ts` holds this rule.
-keepattributes *Annotation*
-keepclassmembers class com.mtggrimoire.app.MainActivity$ImmersiveBridge {
    @android.webkit.JavascriptInterface public <methods>;
}
