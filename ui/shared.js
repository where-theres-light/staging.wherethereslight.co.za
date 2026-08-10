/* Where There's Light — catalog data + cart */
/* R() returns the inlined blob URL when bundled standalone, else the file path. */
const R = (id, path) => (window.__resources && window.__resources[id]) || path;

/* ---------- Catalog data source ----------
   The catalog (products, editions, categories) is authoritative in a Supabase
   table in production; in the offline dev build it is seeded into localStorage
   by demo.js. Either way it is read from localStorage under `wtl_catalog`, so
   the render path below is identical for both builds. */
const CATALOG_KEY = 'wtl_catalog';

let DATA = (() => {
  try { return JSON.parse(localStorage.getItem(CATALOG_KEY)); } catch (e) { return null; }
})() || { categories: {}, editions: [], products: [] };

/* Map a product (products/variants model) onto the legacy piece shape the
   renderers still consume — a thin adapter so the data model can be the single
   source of truth without rewriting product.html / renderCollection yet. */
function toLegacyPiece(p) {
  const print = (p.variants || []).find(v => v.kind === 'print');
  const orig  = (p.variants || []).find(v => v.kind === 'original');
  return {
    id: p.id, title: p.title, place: p.place, year: p.year,
    img: p.image, large: p.imageLarge || p.image,
    orientation: p.orientation, cat: p.category, size: p.size,
    blurb: p.blurb,
    printPrice: print ? print.price : null,
    original: orig ? { price: orig.price, status: orig.status } : { price: null, status: 'sold' },
    fromPrint: print ? print.price : (orig ? orig.price : null)
  };
}

/* Legacy-compatible views, rebuilt whenever DATA changes. Gift tags render from
   their own page data, so they are excluded from CATALOG. */
let CATALOG, EDITIONS, CATEGORIES;
function rebuildViews() {
  CATEGORIES = DATA.categories || {};
  EDITIONS   = DATA.editions   || [];
  CATALOG    = (DATA.products || [])
    .slice()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .filter(p => p.category !== 'gifttags')
    .map(toLegacyPiece);
}
rebuildViews();

//online-start
/* Production: the catalogue is public, read-only data served straight from the
   Supabase REST API (PostgREST) with the publishable key — no edge function.
   Fetch the tables, reshape into the demo.js shape, cache it, rebuild the views
   and let listening pages re-render. URL + key are public; the guard no-ops
   until they are set. */
const SUPABASE_URL  = 'https://ihwtedrjfusvpmkmrgxa.supabase.co';
const SUPABASE_ANON = 'sb_publishable_bsqtDsgESnBFIDsTDAprdQ_xoB4JK-M';
const money = v => (v === null || v === undefined ? null : Number(v));
async function refreshCatalog() {
  if (SUPABASE_URL.includes('YOUR-PROJECT')) return;   // not provisioned yet
  const rest = SUPABASE_URL + '/rest/v1';
  const headers = { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON };
  try {
    const [cRes, eRes, pRes] = await Promise.all([
      fetch(`${rest}/categories?select=slug,title,eyebrow,intro,empty,category_tiers(key,name,sub,price)&order=sort&category_tiers.order=sort`, { headers }),
      fetch(`${rest}/print_editions?select=key,kind,name,sub,price&order=sort`, { headers }),
      fetch(`${rest}/products?select=id,category_slug,title,place,year,size,orientation,tag_range,blurb,image,image_large,sort,product_variants(key,kind,name,sub,price,status)&order=sort&product_variants.order=sort`, { headers }),
    ]);
    if (!cRes.ok || !eRes.ok || !pRes.ok) return;
    const [cRows, eRows, pRows] = await Promise.all([cRes.json(), eRes.json(), pRes.json()]);
    DATA = {
      categories: Object.fromEntries(cRows.map(c => [c.slug, {
        title: c.title, eyebrow: c.eyebrow, intro: c.intro,
        ...(c.empty ? { empty: c.empty } : {}),
        ...(c.category_tiers && c.category_tiers.length
          ? { tiers: c.category_tiers.map(t => ({ ...t, price: money(t.price) })) } : {}),
      }])),
      editions: eRows.map(e => ({ ...e, price: money(e.price) })),
      products: pRows.map(p => ({
        id: p.id, category: p.category_slug, title: p.title,
        place: p.place, year: p.year, size: p.size, orientation: p.orientation,
        range: p.tag_range, blurb: p.blurb, image: p.image, imageLarge: p.image_large,
        sort: p.sort,
        variants: (p.product_variants || []).map(v => ({ ...v, price: money(v.price) })),
      })),
    };
    localStorage.setItem(CATALOG_KEY, JSON.stringify(DATA));
    rebuildViews();
    document.dispatchEvent(new Event('catalog:updated'));
  } catch (e) { /* keep the cached catalog on failure */ }
}
refreshCatalog();
//online-end

const ZAR = n => 'R ' + n.toLocaleString('en-ZA');
const byId = id => CATALOG.find(p => p.id === id);
const byCat = cat => CATALOG.filter(p => p.cat === cat);

/* Products in a category, in the raw (products/variants) model — for pages that
   render the new shape directly rather than the legacy piece view. */
const productsIn = cat => (DATA.products || [])
  .filter(p => p.category === cat)
  .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

/* Run a catalog-dependent render once the data is available, and again whenever
   it refreshes. With the demo seed (dev) or a warm cache the data is already
   present so fn runs immediately; on the online build's cold cache fn waits for
   the async fetch to dispatch `catalog:updated`. Renders must be idempotent. */
const _catalogRenders = [];
function withCatalog(fn){
  _catalogRenders.push(fn);
  if((DATA.products || []).length) fn();
}
document.addEventListener('catalog:updated', () => { for(const fn of _catalogRenders) fn(); });

/* ---------- Collection grid renderer ---------- */
function renderCollection(cat, mountId){
  const meta = CATEGORIES[cat] || {};
  const items = byCat(cat);
  const eb=document.getElementById('collEyebrow'); if(eb) eb.textContent=meta.eyebrow||'';
  const tt=document.getElementById('collTitle'); if(tt) tt.textContent=meta.title||'The Collection';
  const intro=document.getElementById('collIntro'); if(intro) intro.textContent=meta.intro||'';
  document.title=`${meta.title||'The Collection'} — Where There's Light`;
  const mount=document.getElementById(mountId); if(!mount) return;
  if(!items.length){
    mount.className='';
    mount.innerHTML=`<div class="coll-empty"><div class="coll-empty-inner"><span class="eyebrow">Coming soon</span><p>${meta.empty||'This collection is on its way.'}</p><a class="btn btn-ghost" href="index.html#collection">Browse Townscapes</a></div></div>`;
    return;
  }
  mount.className='gallery';
  mount.innerHTML=items.map((p,i)=>{
    const feature = i===0 ? ' feature':'';
    const pricing = `<div class="from">from ${ZAR(p.fromPrint)}</div>` + (p.original.status==='sold'
      ? '<span class="sold">Original sold</span>'
      : `<div class="amt">${ZAR(p.original.price)}</div>`);
    return `<figure class="piece${feature}"><a href="product.html?piece=${p.id}"><div class="mat"><div class="imgwrap"><img src="${p.img}" alt="${p.title} townscape" loading="lazy"></div></div><figcaption class="cap"><div><div class="ttl">${p.title}</div><div class="place">${p.place} · ${p.year}</div></div><div class="pricing">${pricing}</div></figcaption></a></figure>`;
  }).join('');
}

/* ---------- Cart ---------- */
const Cart = {
  key:'wtl_cart',
  read(){ try{return JSON.parse(localStorage.getItem(this.key))||[]}catch(e){return[]} },
  write(items){ localStorage.setItem(this.key, JSON.stringify(items)); this.render(); },
  add(item){ const items=this.read(); items.push(item); this.write(items); toast('Added to cart'); this.open(); },
  remove(i){ const items=this.read(); items.splice(i,1); this.write(items); },
  count(){ return this.read().length; },
  total(){ return this.read().reduce((s,x)=>s+x.price,0); },
  open(){ document.getElementById('cartScrim')?.classList.add('open'); document.getElementById('cartDrawer')?.classList.add('open'); },
  close(){ document.getElementById('cartScrim')?.classList.remove('open'); document.getElementById('cartDrawer')?.classList.remove('open'); },
  render(){
    document.querySelectorAll('[data-cart-count]').forEach(el=>{ el.textContent=this.count(); });
    const body=document.getElementById('cartBody'); if(!body) return;
    const items=this.read();
    if(!items.length){ body.innerHTML='<div class="cart-empty">Your cart is quiet.<br>Find a town worth keeping.</div>'; }
    else{
      body.innerHTML=items.map((it,i)=>`<div class="cart-line">
        <img src="${it.img}" alt="">
        <div class="meta"><div class="t">${it.title}</div><div class="s">${it.edition}</div>
        <button class="rm" onclick="Cart.remove(${i})">Remove</button></div>
        <div class="t" style="font-size:1rem">${ZAR(it.price)}</div></div>`).join('');
    }
    const tot=document.getElementById('cartTotal'); if(tot) tot.textContent=ZAR(this.total());
    const co=document.getElementById('checkoutBtn'); if(co) co.style.display=items.length?'':'none';
  }
};
let toastTimer;
function toast(msg){
  let t=document.getElementById('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200);
}
/* ---------- Checkout ---------- */
/* Base (offline/dev) behaviour: real payments need the back-end, so the preview
   build just says so. The //online block below replaces it with the PayFast
   flow in production. */
const Checkout = {
  start(){ toast('Checkout is not available in this preview'); }
};

//online-start
Checkout.start = function(){
  const items = Cart.read();
  if(!items.length){ toast('Your cart is empty'); return; }
  Cart.open();
  const body = document.getElementById('cartBody');
  if(!body) return;
  body.innerHTML = `
    <form id="coForm" class="checkout-form">
      <h4>Shipping details</h4>
      <label>Full name<input name="name" required autocomplete="name"></label>
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Address<input name="line1" required autocomplete="address-line1"></label>
      <label>Suburb / complex<input name="line2" autocomplete="address-line2"></label>
      <div class="co-row">
        <label>City<input name="city" required autocomplete="address-level2"></label>
        <label>Province<input name="province" autocomplete="address-level1"></label>
      </div>
      <div class="co-row">
        <label>Postal code<input name="postcode" required autocomplete="postal-code"></label>
        <label>Phone<input name="phone" type="tel" autocomplete="tel"></label>
      </div>
      <p class="co-note">Shipping ${ZAR(150)} · secure payment via PayFast.</p>
      <button type="submit" class="btn btn-primary co-pay">Pay ${ZAR(Cart.total()+150)}</button>
      <button type="button" class="btn btn-ghost co-back">Back to cart</button>
    </form>`;
  document.getElementById('coForm').addEventListener('submit', Checkout.submit);
  body.querySelector('.co-back').addEventListener('click', ()=>Cart.render());
};

Checkout.submit = async function(e){
  e.preventDefault();
  const btn = e.target.querySelector('.co-pay');
  btn.disabled = true; btn.textContent = 'Starting…';
  const fd = new FormData(e.target);
  const g = k => (fd.get(k) || '').toString().trim();
  const buyer = { name: g('name'), email: g('email') };
  const ship  = { line1:g('line1'), line2:g('line2'), city:g('city'), province:g('province'),
                  postcode:g('postcode'), country:'South Africa', phone:g('phone') };
  const items = Cart.read().map(l => ({ ref: l.ref, qty: 1 }));
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/create-order', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({ buyer, ship, items }),
    });
    const out = await res.json();
    if(!res.ok){ toast(out.error || 'Could not start checkout'); btn.disabled=false; btn.textContent='Try again'; return; }
    const pf = document.createElement('form');
    pf.method = 'POST'; pf.action = out.process_url;
    for(const [k,v] of Object.entries(out.fields)){
      const i = document.createElement('input'); i.type='hidden'; i.name=k; i.value=v; pf.appendChild(i);
    }
    document.body.appendChild(pf); pf.submit();   // leaves the site for PayFast
  } catch(err){ toast('Network error — please try again'); btn.disabled=false; btn.textContent='Try again'; }
};
//online-end

document.addEventListener('DOMContentLoaded',()=>{
  Cart.render();
  const btn = document.getElementById('checkoutBtn');
  if(btn) btn.onclick = () => Checkout.start();   // overrides the inline preview handler

  // Mobile nav: on touch (no hover) a tap toggles the submenu instead of relying
  // on :hover, which tap-throughs to the first item. Submenu links navigate.
  if(!matchMedia('(hover: hover)').matches){
    document.querySelectorAll('.nav-item > a').forEach(link=>{
      const item = link.parentElement;
      if(!item.querySelector('.submenu')) return;
      link.addEventListener('click', e=>{
        e.preventDefault();
        const open = item.classList.contains('open');
        document.querySelectorAll('.nav-item.open').forEach(o=>o.classList.remove('open'));
        if(!open) item.classList.add('open');
      });
    });
    document.addEventListener('click', e=>{
      if(!e.target.closest('.nav-item')) document.querySelectorAll('.nav-item.open').forEach(o=>o.classList.remove('open'));
    });
  }
});
