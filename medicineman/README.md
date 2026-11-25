# medicineman

Published output for the Medicine Man brand (medicinemandenver.com), committed
by the sync workflow and served via GitHub Pages. Do not hand-edit files in
this directory — hours change in Google Business Profile, nowhere else.

The site is Next.js (Vireo-Health/vireo-mm), not Webflow: it reads
`stores.json` from here while it runs, so these files are the brand's only
output and there is no CMS to patch.

First sync pending: run the workflow with **resolve** + **dry_run** for
`medicineman`, review the proposed baseline, then run with **accept_all**.
