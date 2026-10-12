// tools/build.mjs
import { readFile, writeFile, mkdir, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const TPL_DIR = join(ROOT, "templates");
const LAYOUT_PATH = join(TPL_DIR, "layout.html");
const HEAD_TPL_PATH = join(TPL_DIR, "head-template.html");

const TITLE_MAX = 60;
const DESC_MAX = 160;

const getArg = (p) => {
    const a = (process.argv || []).find(x => typeof x === "string" && x.startsWith(p));
    return a ? a.slice(p.length) : null;
};
const configPathArg = getArg("--config=") || "site.config.json";
const onlyKey = getArg("--key=");
const onlyLang = getArg("--lang=");

const tSlash = s => (s.endsWith("/") ? s : s + "/");
const ensureDir = p => mkdir(p, { recursive: true });
const nowISO = () => new Date().toISOString();

function ogLocale(lang) {
    const map = { ru:"ru_RU", en:"en_US", de:"de_DE", fr:"fr_FR", es:"es_ES", it:"it_IT", pt:"pt_PT" };
    return map[lang] || `${lang}_${lang.toUpperCase()}`;
}
function warnLengths(meta, tag){
    const t = (meta.title||"").trim();
    const d = (meta.description||"").trim();
    if (t.length > TITLE_MAX) console.warn(`! [${tag}] TITLE ${t.length} символов (реком. ≤ ${TITLE_MAX})`);
    if (d.length > DESC_MAX)  console.warn(`! [${tag}] DESCRIPTION ${d.length} символов (реком. ≤ ${DESC_MAX})`);
}

/* ---------- SITEMAP (with hreflang alternates) ---------- */
function buildSitemap(entries){
    const rows = entries.map(e => {
        const alts = (e.alternates||[])
            .map(a => `\n    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`)
            .join("");
        return `  <url>
    <loc>${e.loc}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${e.priority ?? "0.7"}</priority>${alts}
  </url>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml">
${rows}
</urlset>`;
}
function buildRobots(canonicalRoot){
    const root = tSlash(canonicalRoot);
    return `User-agent: *
Allow: /
Sitemap: ${root}sitemap.xml`;
}

/* ---------- Paths / hreflang helpers ---------- */
function pathDepthPrefix(pathWithSlash) {
    const clean = pathWithSlash.replace(/^\//, '').replace(/\/$/, '');
    if (!clean) return "";
    const depth = clean.split('/').length; // e.g. "en/about" -> 2 => "../../"
    return '../'.repeat(depth);
}
function buildHrefLangs(allLangs, defaultLocale, urlsByLang, xDefaultOverride){
    const lines = [];
    for (const l of allLangs) {
        const href = urlsByLang[l];
        if (href) lines.push(`<link rel="alternate" hreflang="${l}" href="${href}" />`);
    }
    const xdef = xDefaultOverride || urlsByLang[defaultLocale] || Object.values(urlsByLang)[0];
    if (xdef) lines.push(`<link rel="alternate" hreflang="x-default" href="${xdef}" />`);
    return lines.join("\n  ");
}

function baseLangCode(lang) {
    return (lang || "").toLowerCase().split("-")[0];
}

function flagFileFor(lang, cfg) {
    if (!cfg) return `${baseLangCode(lang)}.svg`;
    const custom = cfg.langFlags && (cfg.langFlags[lang] || cfg.langFlags[baseLangCode(lang)]);
    if (custom) return custom;
    return `${baseLangCode(lang)}.svg`;
}

function shortLabel(lang) {
    const parts = (lang || "").split("-");
    return (parts[parts.length - 1] || parts[0] || "").toUpperCase();
}

/**
 * renderLangSwitcher(cfg, pageKey, currentLang, assetBase, urlMapByKey)
 * - cfg: конфиг (site.config.json)
 * - pageKey: key страницы (чтобы брать ссылки на ту же страницу в других языках)
 * - currentLang: текущая языковая метка ("en"|"fr" и т.д.)
 * - assetBase: merged.ASSET_BASE ("/" или "../../")
 * - urlMapByKey: карта url'ов для страницы по языкам (создаётся ранее)
 */
function renderLangSwitcher(cfg, pageKey, currentLang, assetBase, urlMapByKey) {
    const langs = langsForSwitcher(cfg); // <- ключевое: берём именно отсюда список языков
    if (!langs || !langs.length) return "";

    const urls = urlMapByKey[pageKey] || {};
    const currentFlag = flagFileFor(currentLang, cfg);
    const currentShort = shortLabel(currentLang);

    const items = langs.map((lang, idx) => {
        // берем URL строго по ключу языка; если нет — fallback:
        // 1) url для defaultLocale
        // 2) canonical root
        // 3) "#"
        const href = urls[lang] || (cfg.defaultLocale && urls[cfg.defaultLocale]) || cfg.canonical || "#";
        const flag = flagFileFor(lang, cfg);
        const short = shortLabel(lang);
        const currentClass = (lang === currentLang) ? " current-lang" : "";
        return `
      <li class="lang-item lang-item-${idx} lang-item-${baseLangCode(lang)}${currentClass}">
        <a lang="${lang}" hreflang="${lang}" href="${href}">
          <img src="${assetBase}assets/img/flags/${flag}" alt="${short}" width="16" height="11" style="width:16px;height:11px;" />
          <span style="margin-left:.3em;">${short}</span>
        </a>
      </li>`;
    }).join("\n");

    // Если currentLang отсутствует в langs (например, текущая страница на другом языке),
    // покажем первый элемент списка как текущий
    const visibleFlag = langs.includes(currentLang) ? currentFlag : flagFileFor(langs[0], cfg);
    const visibleShort = langs.includes(currentLang) ? currentShort : shortLabel(langs[0]);

    return `
  <div class="langswitcher">
    <div class="langtoggler">
      <span><img width="16" height="11" src="${assetBase}assets/img/flags/${visibleFlag}" alt="${visibleShort}"></span>
      <span>${visibleShort}</span>
    </div>
    <ul class="langflags">
      ${items}
    </ul>
  </div>`;
}

/* ---------- Head templating ---------- */
function fillHead(tpl, m){
    return tpl
        .split("{{TITLE}}").join(m.title || "")
        .split("{{DESCRIPTION}}").join(m.description || "")
        .split("{{KEYWORDS}}").join(m.keywords || "")
        .split("{{CANONICAL}}").join(m.canonical || "")
        .split("{{THEME_COLOR}}").join(m.themeColor || "#000000")
        .split("{{OG_IMAGE}}").join(m.ogImage || "/og.jpg")
        .split("{{OG_LOCALE}}").join(m.ogLocale || "en_US")
        .split("{{CSS_HREF}}").join(m.CSS_HREF || "assets/style.css")
        .split("{{ASSET_BASE}}").join(m.ASSET_BASE || "/")
        .split("{{LASTMOD}}").join(m.lastmod || nowISO())
        .replace("{{HREFLANGS}}", m.hrefLangs || "")
        .replace("{{GOOGLE_VERIFICATION}}", m.googleVerificationTag || "")
        .replace("{{EXTRA_HEAD}}", m.extraHead || "");}

/* ---------- Partials / IO ---------- */
async function loadPartial(pathStr){
    if (!pathStr) return "";
    try { return await readFile(resolve(ROOT, pathStr), "utf8"); }
    catch { return ""; }
}
function applyLayout(layout, head, content, htmlLang, partials){
    let html = layout.split("{{HEAD}}").join(head)
        .split("{{CONTENT}}").join(content)
        .split("{{HTML_LANG}}").join(htmlLang || "en");
    html = html.replace(/\{\{PARTIAL:([\w-]+)\}\}/g, (_, name) => partials[name] ?? "");
    html = html.replace("{{JS_BODY}}", partials.JS_BODY ?? "");

    return html;
}

/* ---------- Render helpers (nav/header/footer) ---------- */
function pick(obj, lang, def) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[lang] || obj[def] || Object.values(obj)[0] || "";
}
function langsForSwitcher(cfg) {
    if (Array.isArray(cfg.langs) && cfg.langs.length) return cfg.langs;
    if (cfg.langFlags && typeof cfg.langFlags === 'object') return Object.keys(cfg.langFlags);
    return (cfg.locales && cfg.locales.length) ? cfg.locales : [];
}
function renderNav(config, lang){
    if (!config.navigation || !config.navigation.length) return "";
    const items = config.navigation.map(n => {
        const label = pick(n.label, lang, config.defaultLocale);
        const page = (config.pages || []).find(p => p.key === n.toKey);
        // Улучшенный fallback: сначала текущий язык, потом defaultLocale, потом любой доступный
        let i18n = page?.i18n?.[lang];
        if (!i18n) i18n = page?.i18n?.[config.defaultLocale];
        if (!i18n && page?.i18n) i18n = Object.values(page.i18n)[0];
        const href = i18n ? i18n.path : "#";
        return `<li><a href="${href}">${label}</a></li>`;
    }).join("\n");
    return `<nav><ul>${items}</ul></nav>`;
}
function renderNavList(config, lang) {
    if (!config.navigation || !config.navigation.length) return "";
    return config.navigation.map(n => {
        const label = pick(n.label, lang, config.defaultLocale);
        const page = (config.pages || []).find(p => p.key === n.toKey);
        // Улучшенный fallback: сначала текущий язык, потом defaultLocale, потом любой доступный
        let i18n = page?.i18n?.[lang];
        if (!i18n) i18n = page?.i18n?.[config.defaultLocale];
        if (!i18n && page?.i18n) i18n = Object.values(page.i18n)[0];
        const href = i18n ? i18n.path : "#";
        return `<li><a href="${href}">${label}</a></li>`;
    }).join("\n");
}
function renderFooterMenus(config, lang) {
    const def = config.defaultLocale;
    const sections = (config.footer && config.footer.sections) ? config.footer.sections : [
        {
            title: { [def]: "Pages" },
            items: (config.navigation || []).map(n => ({ toKey: n.toKey, label: n.label }))
        }
    ];
    const sectionHtml = sections.map(sec => {
        const title = pick(sec.title, lang, def);
        const items = (sec.items || []).map(it => {
            const label = pick(it.label, lang, def) ||
                pick((config.navigation || []).find(n => n.toKey === it.toKey)?.label, lang, def) ||
                it.toKey || it.href || "";
            const page = (config.pages || []).find(p => p.key === it.toKey);
            // Улучшенный fallback: сначала текущий язык, потом defaultLocale, потом любой доступный
            let pagePath = page?.i18n?.[lang]?.path;
            if (!pagePath) pagePath = page?.i18n?.[def]?.path;
            if (!pagePath && page?.i18n) pagePath = Object.values(page.i18n)[0]?.path;
            const href = it.href || pagePath || "#";
            return `<li><a href="${href}">${label}</a></li>`;
        }).join("\n");
        return `
      <div class="footer__menu">
        <div class="footer__title">${title}</div>
        <ul>${items}</ul>
      </div>`;
    }).join("\n");
    return sectionHtml;
}
function renderHeaderBlocks(config, lang, assetBase) {
    const blocks = (config.header?.blocks || []);
    return blocks.map(b => {
        const href  = pick(b.href, lang, config.defaultLocale) || "#";
        const icon  = b.icon || "";
        const title = pick(b.title, lang, config.defaultLocale);
        const text  = pick(b.text,  lang, config.defaultLocale);
        const imgSrc = `${assetBase}assets/img/${icon}`;
        return `
      <a href="${href}" class="block">
        <div class="block__icon"><img src="${imgSrc}" alt="${title}"></div>
        <div class="block__description"><span>${title}</span><span>${text}</span></div>
      </a>`;
    }).join("\n");
}

async function getFileMtimeISO(absPath){
    try { const s = await stat(absPath); return new Date(s.mtime).toISOString(); }
    catch { return nowISO(); }
}

/* ========================== MAIN ========================== */
async function main(){
    const cfg = JSON.parse(await readFile(resolve(ROOT, configPathArg), "utf8"));
    const domain = cfg.domain;
    const canonicalRoot = cfg.canonical;
    const dropGlueDomain = cfg.dropGlue?.domain || null;
    const locales = (cfg.locales && cfg.locales.length) ? cfg.locales : ["en"];
    const defaultLocale = cfg.defaultLocale || locales[0];
    if (!domain || !canonicalRoot) throw new Error("В site.config.json нужны 'domain' и 'canonical'");

    const layout = await readFile(LAYOUT_PATH, "utf8");
    const headTpl = await readFile(HEAD_TPL_PATH, "utf8");
    const headerTpl = await loadPartial(cfg.partials && cfg.partials.header);
    const footerTpl = await loadPartial(cfg.partials && cfg.partials.footer);
    const yearStr = String(new Date().getFullYear());
    const siteName = cfg.siteName || cfg.domain;

    // output dir + copy assets
    const siteOut = join(DIST, domain);
    await ensureDir(siteOut);
    if (cfg.assets && cfg.assets.global && existsSync(resolve(ROOT, cfg.assets.global))) {
        await cp(resolve(ROOT, cfg.assets.global), join(siteOut, "assets"), { recursive: true });
    }

    const rootIcons = [
        "favicon.ico",
        "favicon.svg",
        "apple-touch-icon.png",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "android-chrome-192x192.png",
        "android-chrome-512x512.png",
        "site.webmanifest"
    ];

    for (const f of rootIcons) {
        const src = join(siteOut, "assets", f);
        if (existsSync(src)) {
            const dst = join(siteOut, f);
            await cp(src, dst);
        }
    }

    // generate colors.css from palette
    if (cfg.palette) {
        const P = cfg.palette || {};
        const css = [];
        // header
        if (P.header && P.header.bg) css.push(`.header { background-color: ${P.header.bg}; }`);
        // buttons
        if (P.tertiary && P.tertiary.default) css.push(`.btn--tertiary { background-color: ${P.tertiary.default}; }`);
        if (P.tertiary && P.tertiary.hover)   css.push(`.btn--tertiary:hover { background-color: ${P.tertiary.hover}; }`);
        if (P.secondary && P.secondary.default) css.push(`.btn--secondary { background-color: ${P.secondary.default}; }`);
        if (P.secondary && P.secondary.hover)   css.push(`.btn--secondary:hover { background-color: ${P.secondary.hover}; }`);
        // ---- FAQ ----
        if (P.faq?.itemBg)
            css.push(`.faq__item { background-color: ${P.faq.itemBg}; }`);
        if (P.faq?.itemText)
            css.push(`.faq__item { color: ${P.faq.itemText}; }`);
        if (P.faq?.titleBg)
            css.push(`.faq__title { background-color: ${P.faq.titleBg}; }`);
        if (P.faq?.titleText)
            css.push(`.faq__title { color: ${P.faq.titleText}; }`);
        if (P.faq?.contentBg)
            css.push(`.faq__content { background-color: ${P.faq.contentBg}; }`);
        if (P.faq?.contentText)
            css.push(`.faq__content { color: ${P.faq.contentText}; }`);
        if (P.faq?.contentBorder)
            css.push(`.faq__content { border-color: ${P.faq.contentBorder}; }`);
        // block
        if (P.block && P.block.bg) css.push(`.block { background-color: ${P.block.bg}; }`);
        if (P.block && P.block.descriptionFirstText) css.push(`.block__description span:first-child { color: ${P.block.descriptionFirstText}; }`);
        if (P.block && P.block.descriptionLastText) css.push(`.block__description span:last-child { color: ${P.block.descriptionLastText}; }`);
        // menu hover
        if (P.menu && P.menu.hoverText) css.push(`.header__menu ul a:hover { color: ${P.menu.hoverText}; }`);
        // table
        if (P.table && P.table.headerBg)   css.push(`.content__inner table th { background-color: ${P.table.headerBg}; }`);
        if (P.table && P.table.headerText) css.push(`.content__inner table th { color: ${P.table.headerText}; }`);
        if (P.table && P.table.zebraBg)    css.push(`.content__inner table tr:nth-child(2n) { background-color: ${P.table.zebraBg}; }`);
        if (P.table && P.table.zebraText)  css.push(`.content__inner table tr:nth-child(2n) { color: ${P.table.zebraText}; }`);
        // offer
        if (P.offer && P.offer.logoBg)   css.push(`.offer__logo { background-color: ${P.offer.logoBg}; }`);
        if (P.offer && P.offer.ratingBg) css.push(`.offer__rating-wrapper { background: ${P.offer.ratingBg} url(../../img/star.svg) no-repeat 8px 50%; }`);
        if (P.offer && P.offer.ratingText) css.push(`.offer__rating-wrapper { color: ${P.offer.ratingText}; }`);
        // list bullets
        if (P.list && P.list.bullet) css.push(`.content__inner ul li:before { color: ${P.list.bullet}; }`);
        // footer links
        if (P.footer && P.footer.linkText)  css.push(`.footer__menu ul a { color: ${P.footer.linkText}; }`);
        if (P.footer && P.footer.linkHover) css.push(`.footer__menu ul a:hover { color: ${P.footer.linkHover}; }`);
        const outCssDir = join(siteOut, "assets/css");
        await ensureDir(outCssDir);
        await writeFile(join(outCssDir, "colors.css"), css.join("\n") + "\n", "utf8");
        console.log("✓ palette -> assets/css/colors.css");
    }

    const sitemapEntries = [];
    const defaultPriority = (cfg.sitemap && cfg.sitemap.defaultPriority) ?? "0.7";

    // URL map for hreflang
    const urlMapByKey = {};
    for (const page of (cfg.pages || [])) {
        if (!page.key || !page.i18n) continue;
        const map = {};
        for (const lang of Object.keys(page.i18n)) {
            const entry = page.i18n[lang];
            const url = tSlash(canonicalRoot) + (entry.path.startsWith("/") ? entry.path.slice(1) : entry.path);
            map[lang] = tSlash(url);
        }
        urlMapByKey[page.key] = map;
    }

    // build pages
    for (const page of (cfg.pages || [])) {
        if (onlyKey && page.key !== onlyKey) continue;
        const langs = Object.keys(page.i18n).filter(l => !onlyLang || l === onlyLang);
        if (!langs.length) continue;

        const rootLangEntry = Object.entries(page.i18n).find(([, e]) => e.path === "/");
        const isHomePage = !!rootLangEntry;
        const xDefaultOverride = (isHomePage && dropGlueDomain) ? dropGlueDomain : undefined;
        let hrefLangsBlock = buildHrefLangs(Object.keys(page.i18n), defaultLocale, urlMapByKey[page.key], xDefaultOverride);
        if (cfg.migrateGlue && isHomePage) hrefLangsBlock = cfg.migrateGlue.homeHreflang;
        const alternatesAll = Object.entries(urlMapByKey[page.key]).map(([hl, href]) => ({ hreflang: hl, href }));
        const xDefaultHref = xDefaultOverride || urlMapByKey[page.key][defaultLocale] || Object.values(urlMapByKey[page.key])[0];
        if (xDefaultHref) alternatesAll.push({ hreflang: "x-default", href: xDefaultHref });

        let representativeLoc = xDefaultHref;
        let representativePriority = page.priority ?? defaultPriority;
        let representativeLastmod = nowISO();

        for (const lang of langs) {
            const p = page.i18n[lang];
            if (!p.path) { console.warn(`! ${page.key}/${lang}: нет path`); continue; }

            // read content
            let content = "";
            let contentAbs = null;
            if (p.contentPath) {
                contentAbs = resolve(ROOT, p.contentPath);
                try { content = await readFile(contentAbs, "utf8"); }
                catch { console.warn(`! Нет contentPath: ${p.contentPath}`); continue; }
            } else if (p.contentHtml) {
                content = p.contentHtml;
            } else {
                console.warn(`! ${page.key}/${lang}: нет contentHtml/contentPath`);
                continue;
            }

            // meta merge
            const lastmodISO = contentAbs ? await getFileMtimeISO(contentAbs) : nowISO();
            const merged = {
                ...cfg.seoDefaults,
                ...p,
                canonical: cfg.migrateGlue ? (cfg.migrateGlue.canonicalBase + (p.path === "/" ? cfg.migrateGlue.rootSubfolder : p.path)) : ((p.path === "/" && dropGlueDomain) ? dropGlueDomain : urlMapByKey[page.key][lang]),
                ogLocale: ogLocale(lang),
                hrefLangs: hrefLangsBlock,
                lastmod: lastmodISO
            };
            const gsc = cfg.googleVerification;
            merged.googleVerificationTag = gsc
                ? `<meta name="google-site-verification" content="${gsc}" />`
                : "";
            warnLengths(merged, `${domain}${p.path} [${lang}]`);

            // CSS/ASSET paths
            const assetsCfg = cfg.assets || {};
            const mode = assetsCfg.mode || "root";
            const publicBase = assetsCfg.publicBase || "/";
            if (mode === "root") {
                const base = tSlash(publicBase);
                merged.ASSET_BASE = base;
                merged.CSS_HREF = base + (assetsCfg.css || "assets/style.css");
            } else {
                const prefix = pathDepthPrefix(p.path);
                merged.ASSET_BASE = prefix;
                merged.CSS_HREF = prefix + (assetsCfg.css || "assets/style.css");
            }

            // ---- JS (простой вариант) ----
            const jsBodyFiles = (cfg.scripts?.body || []).map(s =>
                merged.ASSET_BASE + (s.startsWith("/") ? s.slice(1) : s)
            );
            const JS_BODY_HTML = jsBodyFiles
                .map(src => `<script src="${src}" defer></script>`)
                .join("\n");

            // ---- dynamic partials (header/footer) ----
            const navHtml = renderNav(cfg, lang);
            const navList = renderNavList(cfg, lang);

            const logoHref = pick(cfg.header?.logo?.href, lang, cfg.defaultLocale) || "/";
            const logoSrc  = (cfg.header?.logo?.src) || "logo.png";

            const ctaSignupLabel = pick(cfg.header?.cta?.signup?.label, lang, cfg.defaultLocale) || "Sign up";
            const ctaSignupUrl   = pick(cfg.header?.cta?.signup?.url,   lang, cfg.defaultLocale) || "#";
            const ctaSigninLabel = pick(cfg.header?.cta?.signin?.label, lang, cfg.defaultLocale) || "Login";
            const ctaSigninUrl   = pick(cfg.header?.cta?.signin?.url,   lang, cfg.defaultLocale) || "#";

            const mobileBannerSrc = (cfg.header?.mobileBanner?.src) || "mobile_banner.webp";
            const ctaMobileLabel  = pick(cfg.header?.cta?.mobile?.label, lang, cfg.defaultLocale) || ctaSignupLabel;
            const ctaMobileUrl    = pick(cfg.header?.cta?.mobile?.url,   lang, cfg.defaultLocale) || ctaSignupUrl;

            const heroBgSrc   = (cfg.header?.hero?.bg?.src) || "banner.webp";
            const heroLine1   = pick(cfg.header?.hero?.line1, lang, cfg.defaultLocale) || "";
            const heroLine2   = pick(cfg.header?.hero?.line2, lang, cfg.defaultLocale) || "";
            const heroLine3   = pick(cfg.header?.hero?.line3, lang, cfg.defaultLocale) || "";
            const heroCtaLabel= pick(cfg.header?.hero?.cta?.label, lang, cfg.defaultLocale) || ctaSignupLabel;
            const heroCtaUrl  = pick(cfg.header?.hero?.cta?.url,   lang, cfg.defaultLocale) || ctaSignupUrl;

            const headerBlocks = renderHeaderBlocks(cfg, lang, merged.ASSET_BASE);
            const langSwitcherHtml = renderLangSwitcher(cfg, page.key, lang, merged.ASSET_BASE, urlMapByKey);

            const partials = {
                header: headerTpl
                    .replace("{{NAV}}", navHtml)
                    .replace("{{NAV_LIST}}", navList)
                    .replace("{{LANG_SWITCHER}}", langSwitcherHtml)
                    .replace(/{{ASSET_BASE}}/g, merged.ASSET_BASE)
                    .replace(/{{SITE_NAME}}/g, siteName)
                    .replace(/{{LOGO_HREF}}/g, logoHref)
                    .replace(/{{LOGO_SRC}}/g,  logoSrc)
                    .replace(/{{CTA_SIGNUP_LABEL}}/g, ctaSignupLabel)
                    .replace(/{{CTA_SIGNUP_URL}}/g,   ctaSignupUrl)
                    .replace(/{{CTA_SIGNIN_LABEL}}/g, ctaSigninLabel)
                    .replace(/{{CTA_SIGNIN_URL}}/g,   ctaSigninUrl)
                    .replace(/{{MOBILE_BANNER_SRC}}/g, mobileBannerSrc)
                    .replace(/{{CTA_MOBILE_LABEL}}/g,  ctaMobileLabel)
                    .replace(/{{CTA_MOBILE_URL}}/g,    ctaMobileUrl)
                    .replace(/{{HERO_BG_SRC}}/g,   heroBgSrc)
                    .replace(/{{HERO_LINE1}}/g,    heroLine1)
                    .replace(/{{HERO_LINE2}}/g,    heroLine2)
                    .replace(/{{HERO_LINE3}}/g,    heroLine3)
                    .replace(/{{HERO_CTA_LABEL}}/g, heroCtaLabel)
                    .replace(/{{HERO_CTA_URL}}/g,   heroCtaUrl)
                    .replace("{{HEADER_BLOCKS}}", headerBlocks),

                footer: footerTpl
                    .replace("{{FOOTER_MENUS}}", renderFooterMenus(cfg, lang))
                    .replace(/{{SITE_NAME}}/g, siteName)
                    .replace(/{{YEAR}}/g, yearStr)
                    .replace(/{{ASSET_BASE}}/g, merged.ASSET_BASE)
            };

            // head + layout
            const headHtml = fillHead(headTpl, merged);
            const finalHtml = applyLayout(layout, headHtml, content, lang, {
                ...partials,
                JS_BODY: JS_BODY_HTML
            });
            // write file
            const outDir = join(siteOut, p.path.replace(/^\//,""));
            await ensureDir(outDir);
            const outFile = join(outDir, "index.html");
            await writeFile(outFile, finalHtml, "utf8");
            console.log(`✓ ${domain}${p.path} (${lang}) -> ${outFile}`);

            // representative for sitemap (prefer default locale URL)
            if (merged.canonical === xDefaultHref) {
                representativeLoc = merged.canonical;
                representativeLastmod = lastmodISO;
                representativePriority = (p.priority ?? page.priority ?? defaultPriority);
            }
        }

        // one sitemap entry per key
        sitemapEntries.push({
            loc: representativeLoc,
            lastmod: representativeLastmod,
            priority: representativePriority,
            alternates: alternatesAll
        });
    }

    // sitemap + robots
    if (sitemapEntries.length) {
        const sm = buildSitemap(sitemapEntries);
        await writeFile(join(siteOut, "sitemap.xml"), sm, "utf8");
        const robots = buildRobots(canonicalRoot);
        await writeFile(join(siteOut, "robots.txt"), robots, "utf8");
        console.log(`✓ sitemap/robots: ${domain}`);
    }

    console.log(`Done: dist/${domain}`);
}

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
