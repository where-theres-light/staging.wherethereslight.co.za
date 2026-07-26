/* Where There's Light — Tweaks (look & feel explorer)
   Renders only the Tweaks panel; applies chosen values to :root CSS variables. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "lead": ["#2D3644", "#9F8551"],
  "paper": "warm",
  "serif": "Cormorant",
  "mat": "Framed"
}/*EDITMODE-END*/;

const PAPERS = {
  warm:  { paper:"#F7F6F2", paper2:"#EFEEE8" },
  mist:  { paper:"#E9EAE8", paper2:"#E0E2E0" },
  linen: { paper:"#F3EDE2", paper2:"#E9E1D2" }
};
const SERIFS = {
  Cormorant: "'Cormorant', Georgia, serif",
  Playfair:  "'Playfair Display', Georgia, serif",
  Spectral:  "'Spectral', Georgia, serif"
};

function applyTweaks(t){
  const root = document.documentElement.style;
  if (Array.isArray(t.lead)) { root.setProperty('--green', t.lead[0]); root.setProperty('--gold', t.lead[1]); }
  const p = PAPERS[t.paper] || PAPERS.warm;
  root.setProperty('--paper', p.paper); root.setProperty('--paper-2', p.paper2);
  root.setProperty('--serif', SERIFS[t.serif] || SERIFS.Cormorant);
  document.body.classList.toggle('mat-clean', t.mat === 'Clean');
}

function TweakApp(){
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(()=>{ applyTweaks(t); }, [t]);
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Look & feel" />
      <TweakColor label="Lead colours" value={t.lead}
        options={[["#2D3644","#9F8551"],["#2D3644","#96A4A5"],["#2D3644","#2D3644"],["#9F8551","#2D3644"]]}
        onChange={(v)=>setTweak('lead', v)} />
      <TweakRadio label="Paper" value={t.paper}
        options={["warm","mist","linen"]}
        onChange={(v)=>setTweak('paper', v)} />
      <TweakSection label="Typography" />
      <TweakRadio label="Headline serif" value={t.serif}
        options={["Cormorant","Playfair","Spectral"]}
        onChange={(v)=>setTweak('serif', v)} />
      <TweakSection label="Presentation" />
      <TweakRadio label="Artwork mat" value={t.mat}
        options={["Framed","Clean"]}
        onChange={(v)=>setTweak('mat', v)} />
    </TweaksPanel>
  );
}

// apply persisted/default values immediately on load
applyTweaks(TWEAK_DEFAULTS);

const __tweakMount = document.createElement('div');
document.body.appendChild(__tweakMount);
ReactDOM.createRoot(__tweakMount).render(<TweakApp/>);
