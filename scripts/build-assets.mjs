import { readFileSync, writeFileSync, existsSync } from "node:fs";

const indexHtml = readFileSync("web/remote-index.html", "utf8");
const remoteAppJs = readFileSync("web/remote-app.js", "utf8");
const styleCss = readFileSync("web/style.css", "utf8");
const appJs = existsSync("web/app.js") ? readFileSync("web/app.js", "utf8") : "";

// Read brand SVGs
const logoSvg = existsSync("web/brand/solidbit-logo.svg")
  ? readFileSync("web/brand/solidbit-logo.svg", "utf8")
  : "";
const isotypeSvg = existsSync("web/brand/solidbit-isotype-gray.svg")
  ? readFileSync("web/brand/solidbit-isotype-gray.svg", "utf8")
  : "";
const faviconSvg = existsSync("web/brand/solidbit-favicon.svg")
  ? readFileSync("web/brand/solidbit-favicon.svg", "utf8")
  : "";

// Read QA fake transfer card asset
const cardSvgPath = "web/qa/tarjeta-destino-demo.svg";
const cardSvg = existsSync(cardSvgPath) ? readFileSync(cardSvgPath, "utf8") : "";

// Read menu PNG images (if available in repository)
const menu1Path = "web/menu/mr-burger-hamburguesas-boneless-complementos.png";
const menu1Base64 = existsSync(menu1Path)
  ? readFileSync(menu1Path).toString("base64")
  : "";

const menu2Path = "web/menu/mr-burger-bebidas-extras-postres.png";
const menu2Base64 = existsSync(menu2Path)
  ? readFileSync(menu2Path).toString("base64")
  : "";

const out = `// Embedded static assets from web/ for instant edge delivery
export interface StaticAsset {
  content: string;
  contentType: string;
  isBase64?: boolean;
}

export const staticAssets: Record<string, StaticAsset> = {
  "/": {
    content: ${JSON.stringify(indexHtml)},
    contentType: "text/html; charset=utf-8"
  },
  "/remote-index.html": {
    content: ${JSON.stringify(indexHtml)},
    contentType: "text/html; charset=utf-8"
  },
  "/remote-app.js": {
    content: ${JSON.stringify(remoteAppJs)},
    contentType: "text/javascript; charset=utf-8"
  },
  "/style.css": {
    content: ${JSON.stringify(styleCss)},
    contentType: "text/css; charset=utf-8"
  },
  "/app.js": {
    content: ${JSON.stringify(appJs)},
    contentType: "text/javascript; charset=utf-8"
  },
  "/brand/solidbit-logo.svg": {
    content: ${JSON.stringify(logoSvg)},
    contentType: "image/svg+xml; charset=utf-8"
  },
  "/brand/solidbit-isotype-gray.svg": {
    content: ${JSON.stringify(isotypeSvg)},
    contentType: "image/svg+xml; charset=utf-8"
  },
  "/brand/solidbit-favicon.svg": {
    content: ${JSON.stringify(faviconSvg)},
    contentType: "image/svg+xml; charset=utf-8"
  },
  "/qa/tarjeta-destino-demo.svg": {
    content: ${JSON.stringify(cardSvg)},
    contentType: "image/svg+xml; charset=utf-8"
  },
  "/qa/tarjeta-destino-demo.png": {
    content: ${JSON.stringify(cardSvg)},
    contentType: "image/svg+xml; charset=utf-8"
  },
  "/menu/mr-burger-hamburguesas-boneless-complementos.png": {
    content: ${JSON.stringify(menu1Base64)},
    contentType: "image/png",
    isBase64: true
  },
  "/menu/mr-burger-bebidas-extras-postres.png": {
    content: ${JSON.stringify(menu2Base64)},
    contentType: "image/png",
    isBase64: true
  }
};
`;

writeFileSync("cloudflare/crm-app/src/assets.ts", out, "utf8");
console.log("Built cloudflare/crm-app/src/assets.ts with brand and QA assets included.");
