#!/usr/bin/env python3
"""Build the standalone Selah app from the Claude version.

Usage:  python3 tools/build.py [path/to/claude-version/index.html]

It copies the app, adds the web-app head (icon, manifest, sign-in layer),
swaps Claude-specific wording, and adds the family-circle code and sign-out
to Profile. Run it again whenever the Claude version changes.
"""
import pathlib, sys, shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "selah" / "index.html"
OUT = ROOT / "public" / "index.html"

s = SRC.read_text(encoding="utf-8")

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f"build: expected {count} of {old[:70]!r}, found {n}")
    s = s.replace(old, new)

# 1. Proper web-app head
rep('<title>Selah</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n', '')
HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Selah</title>
<meta name="description" content="Selah: walk through the Bible with the women and men who faced what you face. Pause, breathe, come closer.">
<meta name="theme-color" content="#F3F4EF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0F1A1B" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Selah">
<script src="/vendor/supabase-2.116.0.js"></script>
<script src="/config.js"></script>
<script src="/platform.js"></script>
</head>
<body>
"""
s = HEAD + s + "\n</body>\n</html>\n"

# 2. Wording: the AI here is not Claude, and limits are daily
rep("Daily reflections and answers are written by Claude, grounded in the Bible passage you're reading.",
    "Daily reflections and answers are written by AI, grounded in the Bible passage you're reading.")
rep('toast("Claude is busy right now. Showing today\'s guide without the personal reflection.")',
    'toast(e.daily?"You\'ve used today\'s AI help. Here\'s today\'s guide; personal reflections come back tomorrow.":"The AI is busy right now. Showing today\'s guide without the personal reflection.")')
rep("Personal reflections need Claude. This view shows today's guide and the passage.",
    "Personal reflections aren't available right now, so here is today's guide and the passage.")
rep('"Allow Claude when asked to get help writing prayers.":e&&e.code==="rate_limited"?"Claude is busy. Try again in a minute."',
    '"Please sign in again to get help writing prayers.":e&&e.code==="rate_limited"?(e.daily?"You\'ve used today\'s AI help. It comes back tomorrow.":"The AI is busy. Try again in a minute.")')
rep('"Claude needs a short rest. Try again in a minute."',
    '(e.daily?"You\'ve used today\'s AI help. You can keep it or release it, and try again tomorrow.":"The AI is busy. Try again in a minute.")')
rep("Ask needs Claude, which isn't available in this view. Open Selah in the Claude app or claude.ai while signed in.",
    "Ask isn't available right now. Check your internet connection and try again.")
rep('"Allow Claude when asked to use Ask.":e&&e.code==="rate_limited"?"Claude is busy right now. Try again in a minute."',
    '"Please sign in again to use Ask.":e&&e.code==="rate_limited"?(e.daily?"You\'ve reached today\'s Ask limit. It resets tomorrow.":"The AI is busy right now. Try again in a minute.")')
rep('toast("This account can only view Selah. Ask Annie to invite you as an editor.")', 'toast("That didn\'t save. Check your connection.")')

# 3. Profile: family circle code + sign out
rep('<div class="card stack"><b>Your data</b>',
    '${window.SelahCloud&&SelahCloud.enabled?`<div class="card stack"><label for="pf-circle"><b>Family circle code</b></label><p class="small muted">Share one code with your family or friends. Everyone with the same code can see when the others met with God and send encouragement. Leave it empty to stay private.</p><input type="text" id="pf-circle" maxlength="24" autocapitalize="characters" placeholder="For example: OKOYE-FAMILY" value="${h(p.circleCode||"")}"></div>`:""}\n   <div class="card stack"><b>Your data</b>')
rep('${S.isOwner?`<button class="btn soft block" data-act="testers">See testers</button>`:""}`,"Profile")',
    '${S.isOwner?`<button class="btn soft block" data-act="testers">See testers</button>`:""}\n   ${window.SelahCloud&&SelahCloud.enabled?`<button class="btn ghost block" onclick="SelahSignOut()">Sign out</button>`:""}`,"Profile")')
rep('case "pf-save":{const n=$("#pf-name").value.trim();if(n)S.profile.name=n;',
    'case "pf-save":{const n=$("#pf-name").value.trim();if(n)S.profile.name=n;const cc=$("#pf-circle");if(cc)S.profile.circleCode=cc.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g,"").slice(0,24);')

OUT.write_text(s, encoding="utf-8")

# 4. Static files the app loads
src_dir = SRC.parent
for sub in ("bible", "photos"):
    dst = ROOT / "public" / sub
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src_dir / sub, dst)
print(f"build: wrote {OUT.relative_to(ROOT)} ({len(s)//1024} KB) and copied bible/ and photos/")
