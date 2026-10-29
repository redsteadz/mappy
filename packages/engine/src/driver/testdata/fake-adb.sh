#!/usr/bin/env bash
# Fake adb used by android.test.ts. Responds to the commands AndroidDriver issues with canned output.
if [ "$1" = "-s" ]; then shift 2; fi
cmd="$*"
case "$cmd" in
  "version") echo "Android Debug Bridge version 1.0.41" ;;
  "devices -l")
    printf 'List of devices attached\nR58N12345 device usb:1-1 product:o1sxx model:SM_G991B device:o1s transport_id:1\nemulator-5554 unauthorized transport_id:2\n\n' ;;
  "shell getprop ro.product.model;"*)
    printf 'SM-G991B\nsamsung\n34\n14\nPhysical size: 1080x2400\nOverride size: 720x1600\nPhysical density: 420\nOverride density: 280\n' ;;
  "shell pm list packages -3") printf 'package:com.example.notes\npackage:org.fossify.notes\n' ;;
  "shell cmd package query-activities"*)
    printf 'com.android.settings/.Settings\ncom.example.notes/com.example.notes.MainActivity\norg.fossify.notes/.activities.SplashActivity\n' ;;
  "shell dumpsys window | grep"*)
    if [ -f "$FAKE_ADB_POPUP" ]; then
      printf '  mCurrentFocus=Window{abc u0 PopupWindow:1234}\n  mFocusedApp=ActivityRecord{def u0 org.fossify.notes/.activities.MainActivity t42}\n'
    else
      printf '  mCurrentFocus=Window{abc u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}\n  mFocusedApp=ActivityRecord{def u0 org.fossify.notes/.activities.MainActivity t42}\n'
    fi ;;
  "exec-out rm -f /sdcard/mappy_dump.xml;"*)
    printf '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" package="org.fossify.notes" bounds="[0,0][720,1600]" /></hierarchy>UI hierchary dumped to: /sdcard/mappy_dump.xml' ;;
  "shell input text"*) echo "$cmd" > "${FAKE_ADB_LOG:-/dev/null}" ;;
  "shell dumpsys input_method"*) printf '  mInputShown=true\n' ;;
  "shell settings get global"*) printf '1.0\n1.0\n0.5\nnull\n' ;;
  "shell settings put"*|"shell settings delete"*) echo "$cmd" >> "${FAKE_ADB_LOG:-/dev/null}" ;;
  "shell input keyevent"*) ;;
  *) echo "unhandled: $cmd" >&2; exit 1 ;;
esac
