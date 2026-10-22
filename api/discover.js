// ReelRadar live global discovery endpoint. Keep AMODB_API_KEY in Vercel only.
// Movie ratings/certifications are NOT verified by this endpoint.
const groups={
 korean:{type:'multi',language:'ko'},chinese:{type:'multi',language:'zh'},
 japanese:{type:'multi',language:'ja'},filipino:{type:'multi',language:'tl'},
 indian:{type:'movie',language:'hi'},hollywood:{type:'movie',language:'en'},
 african:{type:'movie',countries:['NG','KE','GH','ZA']},
 asian:{type:'movie',languages:['th','id','vi']},
 classics:{type:'movie',from:'1990-01-01',to:'1999-12-31'},
 mature:{type:'movie',genres:'27,53',adult:false},
 kids:{type:'movie',genres:'16,10751',adult:false},
 teens:{type:'movie',genres:'10749,12',adult:false},
 halloween:{type:'movie',genres:'27,14',adult:false},
 holiday:{type:'movie',genres:'10751,35',adult:false},
 romance:{type:'movie',genres:'10749',adult:false},
 family:{type:'movie',genres:'10751',adult:false},
 action:{type:'movie',genres:'28,12',adult:false},
 thriller:{type:'movie',genres:'53',adult:false},
 comedy:{type:'movie',genres:'35',adult:false},
 winter:{type:'movie',genres:'18,10749',adult:false}
};
export default async function handler(req,res){
 const key=process.env.AMODB_API_KEY;
 if(!key)return res.status(500).json({error:'API key not configured'});
 const category=String(req.query.category||'').toLowerCase();
 const spec=groups[category];
 if(!spec)return res.status(400).json({error:'Unsupported discovery category'});
 try{
  const lang=spec.language?[spec.language]:(spec.languages||[]);
  const countries=spec.countries||[];
  const variants=spec.type==='multi'?['movie','tv']:[spec.type];
  const requests=[];
  for(const type of variants){
   const selectors=countries.map(c=>({country:c})).concat(lang.map(l=>({language:l})));
   if(!selectors.length)selectors.push({});
   for(const selector of selectors){
    const u=new URL(`https://api.amodb.dev/3/discover/${type}`);
    u.searchParams.set('language','en-US');
    u.searchParams.set('sort_by','popularity.desc');
    u.searchParams.set('include_adult','false');
    u.searchParams.set('vote_count.gte','8');
    u.searchParams.set('page','1');
    if(selector.country)u.searchParams.set('with_origin_country',selector.country);
    if(selector.language)u.searchParams.set('with_original_language',selector.language);
    if(spec.genres)u.searchParams.set('with_genres',spec.genres);
    if(spec.from)u.searchParams.set('primary_release_date.gte',spec.from);
    if(spec.to)u.searchParams.set('primary_release_date.lte',spec.to);
    requests.push({type,selector,url:u});
   }
  }
  const responses=await Promise.all(requests.map(async ({type,selector,url})=>{
   const r=await fetch(url,{headers:{Authorization:`Bearer ${key}`}});
   if(!r.ok)return [];
   const data=await r.json();
   return (Array.isArray(data.results)?data.results:[]).filter(x=>{
    if(selector.language&&x.original_language!==selector.language)return false;
    if(selector.country&&Array.isArray(x.origin_country)&&x.origin_country.length&&!x.origin_country.includes(selector.country))return false;
    if(spec.from&&(!x.release_date||x.release_date<spec.from||x.release_date>spec.to))return false;
    return true;
   }).map(x=>({...x,media_type:type}));
  }));
  const seen=new Set();
  const results=responses.flat().filter(x=>{
   if(!x.id||!x.poster_path||seen.has(x.media_type+':'+x.id))return false;
   seen.add(x.media_type+':'+x.id);return true;
  }).sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,12);
  res.setHeader('Cache-Control','public, s-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).json({category,results});
 }catch(error){return res.status(502).json({error:'Discovery service temporarily unavailable'});}
}
