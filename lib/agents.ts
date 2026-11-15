import { demoAgents } from './demo';

export type TaskRequest = { title:string; description:string; budgetNear:number; capabilities:string[] };
export type Subtask = { id:string; title:string; capability:string; allocation:number; estimateHours:number };
export type AgentMessage = { id:string; from:'planner'|'marketplace'|'coordinator'|'worker'|'verifier'; type:string; payload:Record<string,unknown>; at:string };
export type BidEvaluation = { agentId:string; amount:number; etaHours:number; capabilityScore:number; priceScore:number; timeScore:number; totalScore:number };

export function planTask(task:TaskRequest):Subtask[] {
  if(!task.title.trim() || task.description.trim().length<20 || !Number.isFinite(task.budgetNear) || task.budgetNear<=0) throw new Error('A title, detailed description, and positive NEAR budget are required.');
  const caps = task.capabilities.length ? task.capabilities : ['Research','Analysis','Delivery'];
  const rawWeights = caps.map((_,i)=>i===0?0.4:i===caps.length-1?0.25:0.35/Math.max(1,caps.length-2));
  const weightTotal = rawWeights.reduce((sum,weight)=>sum+weight,0);
  return caps.map((capability,i)=>({id:`subtask-${i+1}`,title:`${capability}: ${task.title.trim()}`,capability,allocation:Number((task.budgetNear*rawWeights[i]/weightTotal).toFixed(4)),estimateHours:Math.max(1,Math.ceil(task.description.length/120)+i)}));
}

export function evaluateBids(task:TaskRequest, bids:Omit<BidEvaluation,'priceScore'|'timeScore'|'totalScore'>[]):BidEvaluation[] {
  const eligible=bids.filter(b=>b.amount>0 && b.amount<=task.budgetNear && b.etaHours>0 && Number.isFinite(b.etaHours));
  if(!eligible.length) return [];
  const minTime=Math.min(...eligible.map(b=>b.etaHours));
  return eligible.map(b=>{
    const priceScore=Math.max(0,100-(b.amount/task.budgetNear)*45);
    const timeScore=Math.max(0,100-(b.etaHours/minTime-1)*15);
    const capabilityScore=Math.max(0,Math.min(100,b.capabilityScore));
    const totalScore=Math.round(capabilityScore*.6+priceScore*.25+timeScore*.15);
    return {...b,priceScore:Math.round(priceScore),timeScore:Math.round(timeScore),totalScore};
  }).sort((a,b)=>b.totalScore-a.totalScore || a.amount-b.amount);
}

export function selectWinner(evaluations:BidEvaluation[]):BidEvaluation|undefined { return [...evaluations].sort((a,b)=>b.totalScore-a.totalScore)[0]; }

export function verifyDeliverable(requirements:string[],deliverable:string):{score:number;missing:string[];recommendation:'approve'|'revise'} {
  const normalized=deliverable.toLowerCase();
  const missing=requirements.filter(r=>!normalized.includes(r.toLowerCase()));
  const score=Math.max(0,Math.round(100- Math.min(60,missing.length*20) - (deliverable.trim().length<120?20:0)));
  return {score,missing,recommendation:score>=90?'approve':'revise'};
}

export function matchAgents(capabilities:string[]) {
  const wanted=capabilities.map(c=>c.toLowerCase());
  return demoAgents.map(agent=>({...agent,match:Math.round(100*wanted.filter(w=>agent.skills.some(s=>s.toLowerCase().includes(w)||w.includes(s.toLowerCase()))).length/Math.max(wanted.length,1))})).sort((a,b)=>b.match-a.match);
}

export function orchestrateTask(task:TaskRequest,bids:Omit<BidEvaluation,'priceScore'|'timeScore'|'totalScore'>[],deliverable?:string) {
  const subtasks=planTask(task);
  const rankedBids=evaluateBids(task,bids);
  const winner=selectWinner(rankedBids);
  const verified=deliverable ? verifyDeliverable(task.capabilities,deliverable) : undefined;
  const events:AgentMessage[]=[
    {id:'planner-1',from:'planner',type:'plan.created',payload:{subtasks,budgetNear:task.budgetNear},at:'2026-11-12T10:00:00Z'},
    {id:'market-1',from:'marketplace',type:'bids.ranked',payload:{eligibleBids:rankedBids.length,bids:rankedBids},at:'2026-11-12T10:01:00Z'},
  ];
  if(winner) events.push({id:'coordinator-1',from:'coordinator',type:'assignment.selected',payload:{agentId:winner.agentId,amountNear:winner.amount,score:winner.totalScore},at:'2026-11-12T10:02:00Z'});
  if(verified) events.push({id:'verifier-1',from:'verifier',type:'deliverable.verified',payload:verified,at:'2026-11-12T10:03:00Z'});
  return {state:verified?.recommendation==='approve'?'verified':winner?'assigned':'bidding',subtasks,rankedBids,winner,verified,events};
}
