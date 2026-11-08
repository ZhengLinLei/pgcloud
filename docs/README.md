# docs/

Documentation assets for PgCloud.

| Folder | Content |
|---|---|
| [`wiki/`](wiki/) | The PgCloud book in PDF (version 1.1.0: concepts, the Big Manual, the launcher tutorial and the test/benchmark report): [`PgCloud_The_Master_Book_v1.1.0.pdf`](wiki/PgCloud_The_Master_Book_v1.1.0.pdf), plus the A4 cover ([`PGCLOUD_A4.pdf`](wiki/PGCLOUD_A4.pdf)) and back cover ([`PGCLOUD_A4_BACK.pdf`](wiki/PGCLOUD_A4_BACK.pdf)). |
| [`brochure/`](brochure/) | One-page A4 brochure of the PgCloud Launcher 1.1.0: dark ([PDF](brochure/PgCloud_Launcher_A4.pdf), [PNG](brochure/PgCloud_Launcher_A4.png)), light ([PDF](brochure/PgCloud_Launcher_A4_light.pdf), [PNG](brochure/PgCloud_Launcher_A4_light.png)) and both with a **transparent background** for editing on top of your own design ([dark PDF](brochure/PgCloud_Launcher_A4_transparent.pdf) / [PNG](brochure/PgCloud_Launcher_A4_transparent.png), [light PDF](brochure/PgCloud_Launcher_A4_light_transparent.pdf) / [PNG](brochure/PgCloud_Launcher_A4_light_transparent.png)). PNGs are 300 dpi; PDFs keep the text as vectors. Screenshots show a simulated 11-node cluster; failover and deploy figures come from the tests in the book. |
| [`readme/`](readme/) | Architecture diagrams used in the main README (numbered in the order they appear). |
| [`img/`](img/) | PgCloud logo in several variants: transparent, white, and on black or white backgrounds (also rounded). |

More documentation: the project [Wiki](https://github.com/ZhengLinLei/pgcloud/wiki) and the README of each folder:

- [`docker/`](../docker/): build and run each node type on its own machine.
- [`static/`](../static/): files inside the images (entrypoints, failover scripts, config templates).
- [`compose/`](../compose/): single-machine demo cluster.
- [`tools/dashboard/`](../tools/dashboard/): terminal monitoring.
- [`tools/pgcloud-launcher/`](../tools/pgcloud-launcher/): web launcher (deploy and monitor clusters over SSH). `npm run build:demo` builds a front-end only demo with a **DEMO** watermark into this folder (`index.html`, `assets/`, `logo.png`, `favicon.png`; simulated data, no servers). Serve it with `python3 -m http.server -d doc 8000`.
