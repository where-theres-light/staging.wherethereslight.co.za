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
    return `<figure class="piece${feature}"><a href="product.html?piece=${p.id}"><div class="mat"><div class="imgwrap"><img src="${p.img}" alt="${p.title} townscape" loading="lazy"></div></div><figcaption class="cap"><div><div class="ttl">${p.title}</div><div class="place">${p.place}</div></div><div class="pricing">${pricing}</div></figcaption></a></figure>`;
  }).join('');
}

/* ---------- Cart ---------- */
const Cart = {
  key:'wtl_cart',
  read(){ try{return JSON.parse(localStorage.getItem(this.key))||[]}catch(e){return[]} },
  write(items){ localStorage.setItem(this.key, JSON.stringify(items)); this.render(); },
  add(item){
    const items=this.read(); const q=item.qty||1;
    const match=items.find(x=>JSON.stringify(x.ref)===JSON.stringify(item.ref));
    if(match) match.qty=(match.qty||1)+q; else items.push({...item, qty:q});
    this.write(items); toast('Added to cart'); this.open();
  },
  remove(i){ const items=this.read(); items.splice(i,1); this.write(items); },
  /* Change a line's quantity by ±1; drop the line at zero. */
  step(i,d){ const items=this.read(); if(!items[i]) return; const q=(items[i].qty||1)+d;
    if(q<=0) items.splice(i,1); else items[i].qty=Math.min(99,q); this.write(items); },
  count(){ return this.read().reduce((s,x)=>s+(x.qty||1),0); },
  /* Bulk gift-tag pricing: every complete 10 single gift tags is charged at the
     gifttags 'mix10' set price instead of 10 × the single price. Returns the
     amount to knock off the line-item subtotal (0 when fewer than 10). */
  giftDiscount(){
    const giftIds = new Set(productsIn('gifttags').map(p=>p.id));
    const n = this.read().filter(x=>x.ref && x.ref.t==='v' && x.ref.k==='single' && giftIds.has(x.ref.p)).reduce((s,x)=>s+(x.qty||1),0);
    const tiers = (CATEGORIES.gifttags && CATEGORIES.gifttags.tiers) || [];
    const per10  = (tiers.find(t=>t.key==='mix10')  || {}).price;
    const single = (tiers.find(t=>t.key==='single') || {}).price;
    if(n < 10 || per10==null || single==null) return 0;
    return Math.max(0, Math.floor(n/10) * (10*single - per10));
  },
  total(){ return this.read().reduce((s,x)=>s+x.price*(x.qty||1),0) - this.giftDiscount(); },
  open(){ document.getElementById('cartScrim')?.classList.add('open'); document.getElementById('cartDrawer')?.classList.add('open'); },
  close(){ document.getElementById('cartScrim')?.classList.remove('open'); document.getElementById('cartDrawer')?.classList.remove('open'); },
  render(){
    document.querySelectorAll('[data-cart-count]').forEach(el=>{ el.textContent=this.count(); });
    const body=document.getElementById('cartBody'); if(!body) return;
    const items=this.read();
    if(!items.length){ body.innerHTML='<div class="cart-empty">Your cart is quiet.<br>Find a town worth keeping.</div>'; }
    else{
      const disc=this.giftDiscount();
      body.innerHTML=items.map((it,i)=>{
        const q=it.qty||1, single=it.ref&&it.ref.k==='orig';   // originals are one-of-a-kind
        const ctl = single
          ? `<button class="rm" onclick="Cart.remove(${i})">Remove</button>`
          : `<div class="qty"><button class="qbtn" onclick="Cart.step(${i},-1)" aria-label="Decrease">−</button><span class="qn">${q}</span><button class="qbtn" onclick="Cart.step(${i},1)" aria-label="Increase">+</button><button class="rm" onclick="Cart.remove(${i})">Remove</button></div>`;
        return `<div class="cart-line">
        <img src="${it.img}" alt="">
        <div class="meta"><div class="t">${it.title}</div><div class="s">${it.edition}</div>
        ${ctl}</div>
        <div class="t" style="font-size:1rem">${ZAR(it.price*q)}</div></div>`;
      }).join('')
        + (disc>0 ? `<div class="cart-line cart-discount">
        <div class="meta"><div class="t">Gift-tag bulk discount</div><div class="s">Every 10 tags priced as a set of 10</div></div>
        <div class="t" style="font-size:1rem">−${ZAR(disc)}</div></div>` : '');
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
/* The shipping form renders in every build; only the final payment step
   differs. Real payments need the back-end, so offline (dev) submitting the
   form just says checkout isn't available; the //online block below swaps in
   the PayFast flow for production. */
const Checkout = {
  start(){
    const items = Cart.read();
    if(!items.length){ toast('Your cart is empty'); return; }
    Cart.open();
    const body = document.getElementById('cartBody');
    if(!body) return;
    body.innerHTML = `
      <form id="coForm" class="checkout-form">
        <h4>Your details</h4>
        <label>Full name<input name="name" required autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Phone<input name="phone" type="tel" autocomplete="tel"></label>
        <label>Delivery<select name="shipping" class="co-ship">
          <option value="deliver">Shipping — ${ZAR(150)}</option>
          <option value="pickup">Self pickup — no shipping cost</option>
        </select></label>
        <div class="co-ship-fields">
          <label>Address<input name="line1" required autocomplete="address-line1"></label>
          <label>Suburb / complex<input name="line2" autocomplete="address-line2"></label>
          <div class="co-row">
            <label>City<input name="city" required autocomplete="address-level2"></label>
            <label>Province<input name="province" autocomplete="address-level1"></label>
          </div>
          <label>Postal code<input name="postcode" required autocomplete="postal-code"></label>
        </div>
        <p class="co-note">Secure payment via PayFast.</p>
        <button type="submit" class="btn btn-primary co-pay">Pay ${ZAR(Cart.total()+150)}</button>
        <button type="button" class="btn btn-ghost co-back">Back to cart</button>
      </form>`;
    document.getElementById('coForm').addEventListener('submit', Checkout.submit);
    body.querySelector('.co-back').addEventListener('click', ()=>Cart.render());
    const shipSel = body.querySelector('.co-ship'), payBtn = body.querySelector('.co-pay');
    const shipFields = body.querySelector('.co-ship-fields');
    shipSel.addEventListener('change', ()=>{
      const pickup = shipSel.value === 'pickup';
      payBtn.textContent = `Pay ${ZAR(Cart.total() + (pickup ? 0 : 150))}`;
      shipFields.hidden = pickup;   // hide the delivery address for self-pickup
      ['line1','city','postcode'].forEach(n=>{ const el=shipFields.querySelector(`[name="${n}"]`); if(el) el.required = !pickup; });
    });
  },
  submit(e){ e.preventDefault(); toast('Checkout is not available in this preview'); }
};

/* ---------- Mailing-list signup ---------- */
/* "Signup for future communication" (footer → signup.html). The form renders in
   every build; only the write differs. Offline (dev) there is no back-end, so
   the preview just acknowledges without sending anything; the //online block
   below swaps in the real Supabase insert for production. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/* Any signup form drives this: the footer page (signup.html) and the "Notify me"
   button on Upcoming. A form may carry hidden `source`/`topic` fields (which
   page / which upcoming piece) and a `data-done` override for its thank-you
   line; both default sensibly when absent. */
const Signup = {
  /* Replace the form with a thank-you message (idempotent, both builds). */
  done(form, msg){
    const m = msg || form.dataset.done || "Thanks for signing up — we'll be in touch.";
    form.innerHTML = `<div class="signup-done"><h4>You're on the list</h4><p>${m}</p></div>`;
  },
  submit(e){
    e.preventDefault();
    const email = (new FormData(e.target).get('email') || '').toString().trim();
    if(!EMAIL_RE.test(email)){ toast('Please enter a valid email'); return; }
    Signup.done(e.target);
  }
};

//online-start
Signup.submit = async function(e){
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('.signup-btn');
  const label = btn ? btn.textContent : '';   // each form keeps its own button text
  const fd = new FormData(form);
  const email = (fd.get('email') || '').toString().trim().toLowerCase();
  if(!EMAIL_RE.test(email)){ toast('Please enter a valid email'); return; }
  const source = (fd.get('source') || 'footer').toString();
  const topic  = (fd.get('topic')  || '').toString() || null;   // which upcoming piece, if any
  if(btn){ btn.disabled = true; btn.textContent = 'Signing up…'; }
  try {
    // Routed through the signup edge function, which rate-limits by IP and
    // writes as service role — the table is not writable with the public key.
    const res = await fetch(SUPABASE_URL + '/functions/v1/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON,
        Authorization: 'Bearer ' + SUPABASE_ANON,
      },
      body: JSON.stringify({ email, source, topic }),
    });
    const out = await res.json().catch(() => ({}));
    if(res.ok){
      Signup.done(form, out.already ? "You're already on the list — thank you." : '');
      return;
    }
    toast(res.status === 429
      ? 'Too many signups — please try again in a little while'
      : (out.error || 'Could not sign you up — please try again'));
    if(btn){ btn.disabled = false; btn.textContent = label; }
  } catch(err){
    toast('Network error — please try again');
    if(btn){ btn.disabled = false; btn.textContent = label; }
  }
};
//online-end

//online-start
Checkout.submit = async function(e){
  e.preventDefault();
  const btn = e.target.querySelector('.co-pay');
  btn.disabled = true; btn.textContent = 'Starting…';
  const fd = new FormData(e.target);
  const g = k => (fd.get(k) || '').toString().trim();
  const buyer = { name: g('name'), email: g('email') };
  const ship  = { line1:g('line1'), line2:g('line2'), city:g('city'), province:g('province'),
                  postcode:g('postcode'), country:'South Africa', phone:g('phone'), method:g('shipping') };
  const items = Cart.read().map(l => ({ ref: l.ref, qty: l.qty || 1 }));
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
