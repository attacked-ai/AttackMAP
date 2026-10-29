# AuthKit side panel — backup before 2026-10-19 rewrite
Environment: WorkOS Staging environment_01M4APWHQ6DNZ79KMWG79P9ST8, appBranding id app_branding_01M4APWHT6DECNMFSB4YBV2SQD.
Rollback: updateAppBranding with these four values.

## authkitSignInCustomHtml
<div class="aai-panel"><div class="aai-top"><img alt="" src="https://attackedmap.vercel.app/attacked-ai-logo.svg" class="aai-logo"><span class="aai-mark">Attacked<span>.ai</span></span></div><div class="aai-body"><p class="aai-eyebrow">Global risk intelligence · live daily</p><h2 class="aai-title">Every incident.<br>Every <span>blast radius</span>.<br>Mapped.</h2><p class="aai-copy">Cyber, supply-chain, financial, geopolitical and physical incidents, classified through GUARD, with the blast radius traced to named companies.</p></div><div class="aai-strip">Built for clarity under pressure.</div></div>

## authkitSignUpCustomHtml
<div class="aai-panel"><div class="aai-top"><img alt="" src="https://attackedmap.vercel.app/attacked-ai-logo.svg" class="aai-logo"><span class="aai-mark">Attacked<span>.ai</span></span></div><div class="aai-body"><p class="aai-eyebrow">Create your free account</p><h2 class="aai-title">Every incident.<br>Every <span>blast radius</span>.<br>Mapped.</h2><p class="aai-copy">Open the live Attack Map and your industry dashboard, and get the daily brief: what happened, who else is exposed, and what to do about it.</p></div><div class="aai-strip">Bring us your worst day.</div></div>

## authkitSignInCustomCss and authkitSignUpCustomCss (identical)
.aai-panel{box-sizing:border-box;height:100%;display:flex;flex-direction:column;background:#0E1116;color:#FFFFFF}
.aai-top{display:flex;align-items:center;gap:10px;padding:40px 48px 0}
.aai-logo{width:28px;height:28px;display:block}
.aai-mark{font-weight:600;font-size:20px;letter-spacing:-.02em;color:#FFFFFF}
.aai-mark span{color:#FCBD00}
.aai-body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 48px}
.aai-eyebrow{margin:0;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#A6A8AD}
.aai-title{margin:14px 0 0;font-weight:700;font-size:44px;line-height:1.05;letter-spacing:-.03em;color:#FFFFFF}
.aai-title span{color:#FCBD00}
.aai-copy{margin:20px 0 0;max-width:420px;font-size:15px;line-height:1.6;color:#A6A8AD}
.aai-strip{padding:18px 48px;background:#FCBD00;color:#111111;font-weight:700;font-size:14px;letter-spacing:-.01em}
