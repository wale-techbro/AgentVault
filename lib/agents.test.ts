import { describe, expect, it } from 'vitest';
import { evaluateBids, orchestrateTask, planTask, selectWinner, verifyDeliverable } from './agents';

const task={title:'Research African AI companies',description:'Map credible startups, their product focus, funding signals and markets served.',budgetNear:.5,capabilities:['Research','Analysis','Writing']};

describe('agent workflow',()=>{
  it('plans capability subtasks whose allocations add up to the task budget',()=>{
    const plan=planTask(task);
    expect(plan).toHaveLength(3);
    expect(plan.reduce((sum,item)=>sum+item.allocation,0)).toBeCloseTo(task.budgetNear,4);
  });
  it('rejects incomplete work orders',()=>{
    expect(()=>planTask({...task,description:'too short'})).toThrow(/detailed description/);
  });
  it('ranks capable bids and selects the highest combined score',()=>{
    const ranked=evaluateBids(task,[
      {agentId:'research',amount:.42,etaHours:6,capabilityScore:96},
      {agentId:'analyst',amount:.35,etaHours:4,capabilityScore:72},
      {agentId:'generalist',amount:.25,etaHours:12,capabilityScore:55},
    ]);
    expect(selectWinner(ranked)?.agentId).toBe('research');
  });
  it('does not select a bid above the task budget',()=>{
    expect(evaluateBids(task,[{agentId:'over-budget',amount:.8,etaHours:1,capabilityScore:100}])).toEqual([]);
  });
  it('moves shared workflow state through planning, bids, selection, and verification',()=>{
    const result=orchestrateTask(task,[{agentId:'research',amount:.42,etaHours:6,capabilityScore:96}],'Research report with research, analysis, and writing sections. '.repeat(5));
    expect(result.state).toBe('verified');
    expect(result.events.map(event=>event.from)).toEqual(['planner','marketplace','coordinator','verifier']);
  });
  it('flags deliverables missing requested sections',()=>{
    const result=verifyDeliverable(['funding','regional analysis'],'Report: funding signals across Africa. '.repeat(10));
    expect(result.missing).toEqual(['regional analysis']);
    expect(result.recommendation).toBe('revise');
  });
});
