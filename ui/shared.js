/* Where There's Light — catalog data + cart */
/* R() returns the inlined blob URL when bundled standalone, else the file path. */
const R = (id, path) => (window.__resources && window.__resources[id]) || path;
const CATALOG = [
  {
    id:'boston', title:'Boston', place:'Bellville, Cape Town',
    year:2019, img:R('boston_small','assets/boston-small.jpg'), large:R('boston_large','assets/boston-small.jpg'),
    orientation:'landscape',
    cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The old Boston shopfronts gather beneath a dotted dome of Karoo light, hemmed in by a riot of fynbos and garden green.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'swellendam', title:'Swellendam', place:'Overberg, Western Cape',
    year:2018, img:R('swellendam_small','assets/swellendam-small.jpg'),
    orientation:'landscape',
    cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The Drostdy and its oaks, drawn in patient ink — one of the oldest towns in the country, kept in a single quiet frame.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'somersetwest', title:'Somerset West', place:'Helderberg, Western Cape',
    year:2018, img:R('somersetwest_small','assets/somersetwest-small.jpg'),
    orientation:'landscape',
    cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'Steeples, verandahs and a fountained square nestle below the Helderberg, wrapped in a hedge of hand-inked blooms.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'windhoek', title:'Windhoek', place:'Khomas, Namibia',
    year:2020, img:R('windhoek_small','assets/windhoek-small.jpg'),
    orientation:'landscape',
    cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The Christuskirche and the old colonial roofline rise from a desert garden, the mountains pencilled soft behind.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'caledon', title:'Caledon', place:'Overberg, Western Cape',
    year:2017, img:R('caledon_small','assets/caledon-small.jpg'),
    orientation:'landscape',
    cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The Dutch Reformed church and its gables, cradled in the wild garden that gave the town its hot-spring fame.',
    original:{price:1300, status:'sold'},
    fromPrint:360
  },
  {
    id:'london', title:'London', place:'England, United Kingdom',
    year:2023, img:R('london_small','assets/london-small.jpg'),
    orientation:'landscape', cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'Big Ben, the Eye and a skyline of landmarks gathered into a single dome of light, wreathed in an English cottage garden.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'polperro', title:'Polperro', place:'Cornwall, United Kingdom',
    year:2023, img:R('polperro_small','assets/polperro-small.jpg'),
    orientation:'landscape', cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The tumbling harbour cottages of a Cornish fishing village, climbing the hillside above the quay.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'shanghai', title:'Shanghai', place:'China',
    year:2023, img:R('shanghai_small','assets/shanghai-small.jpg'),
    orientation:'landscape', cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'Layered rooftops and the distant tower, drawn inside a circular window of ink and colour — old lanes meeting the modern skyline.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'stanford', title:'Stanford', place:'Overberg, Western Cape',
    year:2022, img:R('stanford_small','assets/stanford-small.jpg'),
    orientation:'landscape', cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The white church spire and village cottages below the Klein River mountains, held in a wild garden of fynbos.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'stellenbosch', title:'Stellenbosch', place:'Cape Winelands, Western Cape',
    year:2022, img:R('stellenbosch_small','assets/stellenbosch-small.jpg'),
    orientation:'landscape', cat:'townscapes', size:'412 × 297 mm', printPrice:360,
    blurb:'The oak-lined town of gables and the old church tower, cradled below the mountains in a hedge of hand-inked blooms.',
    original:{price:1300, status:'available'},
    fromPrint:360
  },
  {
    id:'amelias-house', title:"Home", place:'Miniature interior · 412 × 297 mm',
    year:2021, img:R('home_small','assets/home-small.jpg'),
    orientation:'landscape', cat:'amelias',
    size:'412 × 297 mm',
    printPrice:360,
    blurb:'A gabled cottage nestled in its garden — one of the small, lit houses in the Amelia\u2019s House collection. Perfect to fill a small space on your gallery wall or to group together as a collection.',
    original:{price:null, status:'sold'},
    fromPrint:360
  },
  {
    id:'amelias-kitchen', title:"Amelia's Kitchen", place:'Miniature interior · 120 × 170 mm',
    year:2024, img:R('kitchen_small','assets/kitchen-small.jpg'),
    orientation:'landscape', cat:'amelias', size:'120 × 170 mm', printPrice:170,
    blurb:'A busy little kitchen full of light \u2014 herbs at the window, a cat on the bench and everything in its place. From the Amelia\u2019s House collection.',
    original:{price:null, status:'sold'},
    fromPrint:170
  },
  {
    id:'amelias-reading-room', title:"Amelia's Reading Room", place:'Miniature interior · 120 × 170 mm',
    year:2024, img:R('readingroom_small','assets/readingroom-small.jpg'),
    orientation:'landscape', cat:'amelias', size:'120 × 170 mm', printPrice:170,
    blurb:'A quiet corner to curl up in \u2014 a soft armchair, a lamp and a window onto the city. From the Amelia\u2019s House collection.',
    original:{price:null, status:'sold'},
    fromPrint:170
  },
  {
    id:'amelias-study', title:"Amelia's Study", place:'Miniature interior · 120 × 170 mm',
    year:2024, img:R('study_small','assets/study-small.jpg'),
    orientation:'landscape', cat:'amelias', size:'120 × 170 mm', printPrice:170,
    blurb:'An open book, a cup of coffee and a street view \u2014 the perfect spot to think. From the Amelia\u2019s House collection.',
    original:{price:null, status:'sold'},
    fromPrint:170
  }
];

const EDITIONS = [
  {key:'a4',  name:'Fine-art print · A4', sub:'Open edition · 21 × 30 cm', price:690},
  {key:'a3',  name:'Fine-art print · A3', sub:'Limited edition of 50 · 30 × 42 cm', price:1250},
  {key:'a2',  name:'Fine-art print · A2', sub:'Limited edition of 25 · 42 × 59 cm', price:1950},
  {key:'a3f', name:'Framed A3 print',     sub:'Oak frame, museum glass · edition of 50', price:2450},
  {key:'orig',name:'Original ink drawing',sub:'One of a kind · ink on 300gsm cotton paper', price:null}
];

const CATEGORIES = {
  townscapes:{
    title:'Townscapes',
    eyebrow:'The flagship range',
    intro:'Our flagship range \u2014 collections of towns drawn in pen on high-quality Fabriano paper. Every gable, fountain and garden held inside a dome of light. We are always on the lookout for more beautiful places to capture.'
  },
  amelias:{
    title:"Amelia's House",
    eyebrow:'Miniature interiors',
    intro:'Amelia\u2019s House is a small collection of illustrations. Perfect to fill a small space on your gallery wall, group together as a collection or to add interest to a small space.',
    empty:'New little rooms are being drawn. Join the studio letter and we\u2019ll tell you the moment Amelia\u2019s House opens its doors.'
  },
  gifttags:{
    title:'Gift Tags',
    eyebrow:'In collaboration with Koue Koffie Boeke',
    intro:'We are very proud to be collaborating with Koue Koffie Boeke on our range of gift tags. Our range includes cards perfect for all ages and can be purchased individually or in sets.'
  }
};

const ZAR = n => 'R\u00A0' + n.toLocaleString('en-ZA');
const byId = id => CATALOG.find(p=>p.id===id);
const byCat = cat => CATALOG.filter(p=>p.cat===cat);

/* ---------- Collection grid renderer ---------- */
function renderCollection(cat, mountId){
  const meta = CATEGORIES[cat] || {};
  const items = byCat(cat);
  const eb=document.getElementById('collEyebrow'); if(eb) eb.textContent=meta.eyebrow||'';
  const tt=document.getElementById('collTitle'); if(tt) tt.textContent=meta.title||'The Collection';
  const intro=document.getElementById('collIntro'); if(intro) intro.textContent=meta.intro||'';
  document.title=`${meta.title||'The Collection'} \u2014 Where There's Light`;
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
    return `<figure class="piece${feature}"><a href="product.html?piece=${p.id}"><div class="mat"><div class="imgwrap"><img src="${p.img}" alt="${p.title} townscape" loading="lazy"></div></div><figcaption class="cap"><div><div class="ttl">${p.title}</div><div class="place">${p.place} \u00b7 ${p.year}</div></div><div class="pricing">${pricing}</div></figcaption></a></figure>`;
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
