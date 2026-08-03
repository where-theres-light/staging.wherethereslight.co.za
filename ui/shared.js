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
/* Production: the catalog lives in Supabase. Refresh it, cache it under the same
   key, rebuild the views and let listening pages re-render. The project URL and
   publishable key are filled in when the back-end is provisioned. */
const SUPABASE_URL  = window.__SUPABASE_URL  || '';
const SUPABASE_ANON = window.__SUPABASE_ANON || '';
async function refreshCatalog() {
  if (!SUPABASE_URL) return;
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/catalog', {
      headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON }
    });
    if (!res.ok) return;
    DATA = await res.json();
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
document.addEventListener('DOMContentLoaded',()=>Cart.render());
