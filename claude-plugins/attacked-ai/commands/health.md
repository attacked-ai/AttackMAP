---
description: Check whether the live Supabase project and site are up
allowed-tools: Bash(curl:*)
---

Check the live Attacked.ai backend and site, using one small request each (don't load the incidents dataset):

- `curl -s -o /dev/null -w "%{http_code}" https://ovenyjguhkgiceddzwna.supabase.co/auth/v1/health -H "apikey: sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5"`
- `curl -s -o /dev/null -w "%{http_code}" https://attackedmap.vercel.app/`

Explain the result plainly: 200 = up; 402 = Supabase egress quota exceeded (site data, sign-in and emails are down until the org is upgraded to Pro or the billing cycle resets); anything else = say what it means.
