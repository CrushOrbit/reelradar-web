// ReelRadar entertainment feed proxy: news headlines and podcast directory links.
// No scraped full articles, embedded copyrighted audio, or unverified gossip claims.
const regions={global:'film OR television entertainment',hollywood:'Hollywood film television',korea:'Korean drama Kdrama entertainment',china:'Chinese cinema Cdrama entertainment',japan:'Japanese cinema anime entertainment',india:'Bollywood Indian cinema entertainment',africa:'Nollywood African cinema entertainment',philippines:'Philippine cinema Filipino entertainment'};
function decode(s){return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/<[^>]+>/g,'').trim();}
function tag(xml,name){const m=xml.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));return m?decode(m[1]):'';}
function validUrl(v){try{const u=new URL(v);return u.protocol==='https:'?u.href:'';}catch{return '';}}
export default async function handler(req,res){
 const kind=String(req.query.kind||'news').toLowerCase(),region=String(req.query.region||'global').toLowerCase();
 if(!['news','gossip','podcasts'].includes(kind)||!Object.hasOwn(regions,region))return res.status(400).json({error:'Invalid category or region'});
 res.setHeader('Cache-Control','public, s-maxage=900, stale-while-revalidate=3600');
 try{
  if(kind==='podcasts'){
   const terms={global:'film tv entertainment podcast',hollywood:'Hollywood movies podcast',korea:'Korean drama podcast',china:'Chinese cinema podcast',japan:'Japanese cinema anime podcast',india:'Bollywood podcast',africa:'African cinema Nollywood podcast',philippines:'Filipino cinema podcast'};
   const url=new URL('https://itunes.apple.com/search');url.searchParams.set('term',terms[region]);url.searchParams.set('entity','podcast');url.searchParams.set('media','podcast');url.searchParams.set('limit','16');url.searchParams.set('country','US');
   const r=await fetch(url,{signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('Podcast directory unavailable');const data=await r.json();
   const items=(data.results||[]).filter(x=>x.collectionName&&validUrl(x.collectionViewUrl)).slice(0,12).map(x=>({title:x.collectionName,source:x.artistName||'Podcast',url:validUrl(x.collectionViewUrl),image:validUrl(x.artworkUrl100||''),date:x.releaseDate||'',description:'Listen on Apple Podcasts or find the show in your preferred podcast app.'}));
   return res.status(200).json({kind,region,items,source:'Apple Podcasts directory'});
  }
  const query=kind==='gossip'?`(${regions[region]}) (celebrity OR entertainment OR interview OR relationship)`: `(${regions[region]}) (movie OR series OR casting OR trailer OR streaming)`;
  const url=new URL('https://news.google.com/rss/search');url.searchParams.set('q',query+' when:7d');url.searchParams.set('hl','en-US');url.searchParams.set('gl','US');url.searchParams.set('ceid','US:en');
  const r=await fetch(url,{headers:{'User-Agent':'ReelRadar/1.0 (+entertainment headlines)'},signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('News feed unavailable');const xml=await r.text();
  const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,18).map(m=>{const item=m[1];return {title:tag(item,'title'),url:validUrl(tag(item,'link')),date:tag(item,'pubDate'),source:tag(item,'source')||'News publisher',description:''};}).filter(x=>x.title&&x.url).slice(0,12);
  return res.status(200).json({kind,region,items,source:'Google News RSS — publisher headlines'});
 }catch(e){return res.status(502).json({error:'Feed temporarily unavailable. Please try again.'});}
}
