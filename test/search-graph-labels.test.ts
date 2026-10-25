import {expect,it} from "vitest";
import {graphLabels} from "../web/src/canvas-graph-labels.ts";
import {citationCap,graphRadius,type GraphNode} from "../web/src/canvas-graph-types.ts";
it("prioritizes seed and selected labels, avoids text overlap and limits dense labels",()=>{
 const nodes:GraphNode[]=Array.from({length:300},(_,i)=>({id:`n${i}`,kind:"paper",title:`Paper ${i}`,authors:[`Author ${i}`],year:2020+i%7,isSeed:i===0,citationCount:i,x:0,y:0}));
 const state={revision:0,positions:Object.fromEntries(nodes.map((n,i)=>[n.id,{x:(i%20)*32-300,y:Math.floor(i/20)*40-300}])),viewport:{x:0,y:0,scale:1}};
 const labels=graphLabels(nodes,[],state,800,800,"n150");
 expect(labels.some(l=>l.id==="n150")).toBe(true);expect(labels.some(l=>l.id==="n0")).toBe(true);expect(labels.length).toBeLessThanOrEqual(80);
 for(let a=0;a<labels.length;a++)for(let b=a+1;b<labels.length;b++){const x=labels[a],y=labels[b];expect(x.x<y.x+y.width&&x.x+x.width>y.x&&x.y-11<y.y+3&&x.y+3>y.y-11).toBe(false);}
 const zoomed=graphLabels(nodes,[],{...state,viewport:{x:0,y:0,scale:.2}},800,800,"n150");expect(zoomed.length).toBeLessThanOrEqual(20);
});
it("uses the 95th percentile to cap logarithmic radius outliers",()=>{
 const nodes=Array.from({length:100},(_,i)=>({citationCount:i===99?1e9:100})) as GraphNode[];
 expect(citationCap(nodes)).toBe(100);expect(graphRadius(undefined,100)).toBe(6);expect(graphRadius(1e9,100)).toBe(20);expect(graphRadius(10,100)).toBeGreaterThan(6);
});
