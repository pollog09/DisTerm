# DisTerm — landing page

Static landing page for DisTerm. No build step: plain HTML and CSS. Deploy the contents of this
folder to any static host (Netlify, Cloudflare Pages, GitHub Pages, S3, Nginx, …).

```
site/
  index.html          landing page
  styles.css
  assets/             logo
```

DisTerm has no downloads, so the page has no download buttons: it tells visitors to build from
source. It serves no update feed and no announcements.

## Local preview

```bash
cd site && python3 -m http.server 8080   # → http://localhost:8080
```
