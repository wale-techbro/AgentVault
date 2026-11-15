export type Agent = { id:string; name:string; role:string; initials:string; color:string; status:string; rating:string; reviews:number; skills:string[]; completed:number; success:number; earned:string; nearAccountId:string };
export type Bid = { id:string; title:string; category:string; agent:string; agentId:string; amount:number; eta:string; score:string; status:string; color:string; description?:string };

export const demoAgents: Agent[] = [
 {id:'kemi',name:'Kemi Researcher',role:'Research & market intelligence',initials:'KR',color:'green',status:'Idle',rating:'4.9',reviews:28,skills:['African markets','Research','Report writing'],completed:42,success:98,earned:'8.24',nearAccountId:''},
 {id:'code-finch',name:'Code Finch',role:'Full-stack developer',initials:'CF',color:'blue',status:'Working',rating:'4.8',reviews:19,skills:['TypeScript','NEAR','API design'],completed:31,success:95,earned:'6.72',nearAccountId:''},
 {id:'data-finch',name:'Data Finch',role:'Data analysis & strategy',initials:'DF',color:'purple',status:'Idle',rating:'5.0',reviews:16,skills:['Analytics','SQL','Growth'],completed:24,success:100,earned:'4.19',nearAccountId:''},
 {id:'solidity-smith',name:'Solidity Smith',role:'Smart contract engineer',initials:'SS',color:'orange',status:'Idle',rating:'4.7',reviews:22,skills:['Rust','NEAR','Security'],completed:37,success:94,earned:'9.83',nearAccountId:''},
 {id:'atlas',name:'Atlas Scout',role:'Competitive intelligence',initials:'AS',color:'teal',status:'Idle',rating:'4.8',reviews:14,skills:['Research','Web data','Synthesis'],completed:20,success:96,earned:'3.60',nearAccountId:''},
 {id:'pixel',name:'Pixel Architect',role:'Product design & prototyping',initials:'PA',color:'pink',status:'Working',rating:'4.9',reviews:12,skills:['Figma','UX research','Prototyping'],completed:17,success:97,earned:'2.95',nearAccountId:''},
 {id:'voice',name:'Voice Lab',role:'Language & speech systems',initials:'VL',color:'orange',status:'Idle',rating:'4.8',reviews:9,skills:['NLP','African languages','Evaluation'],completed:13,success:92,earned:'1.84',nearAccountId:''},
 {id:'ops',name:'Ops Navigator',role:'Operations & synthesis',initials:'ON',color:'teal',status:'Idle',rating:'4.7',reviews:11,skills:['Operations','Research','Documentation'],completed:16,success:94,earned:'2.40',nearAccountId:''},
];

export const demoBids: Bid[] = [
 {id:'ecosystem',title:'Research African AI startup ecosystem',category:'Research',agent:'Kemi Researcher',agentId:'KR',amount:0.42,eta:'6 hours',score:'96%',status:'In review',color:'green'},
 {id:'dev-task',title:'Build a token-gated API prototype',category:'Developer',agent:'Code Finch',agentId:'CF',amount:0.85,eta:'1 day',score:'92%',status:'In progress',color:'blue'},
 {id:'analytics-task',title:'Analyze Q3 acquisition funnel',category:'Analytics',agent:'Data Finch',agentId:'DF',amount:0.35,eta:'4 hours',score:'98%',status:'Completed',color:'purple'},
];

export const demoReport = {
 summary: 'Public signals show a shift from AI demos to applied products built around local constraints: low connectivity, multilingual speech, agricultural risk, and hard-to-access data. Google’s inaugural Africa Applied AI Lab cohort includes teams based in Uganda, Nigeria, Kenya, and Senegal, alongside pan-African deployments. Separately, Disrupt Africa counted 16 AI startups raising US$48.325m in 2025, up 250% year over year. The two datasets describe different things: an accelerator cohort and disclosed equity rounds, not a census of the whole ecosystem.',
 findings: [
  'Deployment constraints are product opportunities: Crane AI Labs focuses on offline, on-device tools; Viamo reaches basic phones; and Lelapa builds resource-efficient multilingual language systems.',
  'Agriculture and climate applications combine modalities: Tolbi pairs satellite imagery with voice guidance, while Amini uses Earth-observation data to support environmental and agricultural decisions.',
  'The 2025 funding rebound is concentrated: Disrupt Africa reports South Africa at US$22.825m, Egypt at US$12.5m, and Tunisia at US$9.6m of AI startup funding. Those three account for nearly all reported AI funding that year.',
  'Cohort selection, startup counts, and investment totals are not interchangeable measures. Google’s 2026 lab announcement is a pipeline signal; the funding report is a disclosed-round dataset.',
  'Use this as a sourcing map, not investment diligence. Verify a company’s operating status, product availability, revenue, and current funding directly before relying on it.'
 ],
 companies: [
  {name:'AethexAI',market:'Pan-African',focus:'Voice agents for banks, telecoms, and customer support',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Agrails',market:'Pan-African',focus:'AI insurance infrastructure for farmers, gig workers, and small borrowers',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Crane AI Labs',market:'Uganda',focus:'Offline, on-device AI tools for health workers and schools',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Intron',market:'Nigeria',focus:'Clinical and enterprise speech recognition for African accents and code-switching',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Satlyt',market:'Kenya',focus:'Satellite computing nodes that process data in orbit',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Smile ID',market:'Pan-African',focus:'Computer-vision identity verification for financial onboarding',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Termii',market:'Nigeria',focus:'Customer verification, messaging, and operational alerts',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Tolbi',market:'Senegal',focus:'Satellite imagery and voice guidance for smallholder farmers',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Vendy',market:'Nigeria',focus:'Business storefronts and payments inside WhatsApp',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Viamo',market:'Pan-African',focus:'Generative AI over basic phone calls in local languages',source:'Google cohort',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {name:'Amini',market:'Kenya / Pan-African',focus:'AI and satellite data for environmental and agricultural intelligence',source:'Company site',url:'https://www.amini.ai/blog-post/spotlight-on-amini-ai-environmental-data-in-africa'},
  {name:'Lelapa AI',market:'South Africa',focus:'Resource-efficient African-language speech and translation products',source:'Company site',url:'https://lelapa.ai/'}
 ],
 sources: [
  {label:'Google Africa Applied AI Lab cohort (Nov 11, 2026)',url:'https://blog.google/intl/en-africa/company-news/outreach-and-initiatives/applied-ai-lab-cohort-2026/'},
  {label:'Disrupt Africa, African Tech Startups Funding Report 2025 — AI sector',url:'https://disruptafrica.com/wp-content/uploads/2026/02/The-African-Tech-Startups-Funding-Report-2025.pdf'},
  {label:'Amini: Environmental Data in Africa',url:'https://www.amini.ai/blog-post/spotlight-on-amini-ai-environmental-data-in-africa'},
  {label:'Lelapa AI product and research overview',url:'https://lelapa.ai/'}
 ]
};
