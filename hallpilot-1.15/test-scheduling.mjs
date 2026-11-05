import { readFileSync } from 'node:fs';
// Run: node hallpilot-1.15/test-scheduling.mjs
// Synthetic records only; never accesses production.
const staffSource=readFileSync(new URL('./hallpass-staff.ts',import.meta.url),'utf8');
const publicSource=readFileSync(new URL('./hallpass-public.ts',import.meta.url),'utf8');

async function testScheduling(staffSource, publicSource) {
  const tests=[];
  const verify=(ok,label)=>{if(!ok)throw Error(label);tests.push(label)};
  function load(source,names) {
    const text=source.replace(/^import[^\n]*\n/gm,'').split('export default {')[0];
    return new Function(text+'\nreturn {'+names.join(',')+'}')();
  }
  const staff=load(staffSource,['resolveRoomSchedule','adminRoomSchedulingState','adminAssignRoomSchedules','adminSaveDayExceptions','adminSetRoomSchedulingEnabled']);
  const pub=load(publicSource,['resolveRoomSchedule']);
  const db={
    rooms:[{id:'r1',school_id:'s',room_name:'K1',active:true},{id:'r2',school_id:'s',room_name:'Room 12',active:true},{id:'other',school_id:'other',room_name:'Other',active:true}],
    room_settings:[{room_id:'r1',schedule_mode:'Regular'},{room_id:'r2',schedule_mode:'Regular'},{room_id:'other',schedule_mode:'Regular'}],
    master_schedules:['Regular','K Regular','2 Regular','K Minimum','2 Minimum'].map(schedule_name=>({school_id:'s',schedule_name})),
    room_schedule_assignments:[],school_day_exceptions:[],school_calendar:[{school_id:'s',calendar_date:'2099-11-03',schedule_name:'Minimum',active:true}],
    school_settings:[{school_id:'s',room_scheduling_enabled:false,auto_scheduling_enabled:true}],
    passes:[],waiting_requests:[],audit_log:[]
  };
  class Q {
    constructor(name){this.name=name;this.filters=[];this.mode='read';this.values=[];this.keys='id';this.max=Infinity}
    select(){return this}
    eq(k,v){this.filters.push(x=>String(x[k])===String(v));return this}
    ilike(k,v){this.filters.push(x=>String(x[k]||'').toLowerCase()===String(v||'').toLowerCase());return this}
    in(k,a){this.filters.push(x=>a.map(String).includes(String(x[k])));return this}
    is(k,v){this.filters.push(x=>x[k]==v);return this}
    order(){return this}
    limit(n){this.max=n;return this}
    update(v){this.mode='update';this.values=[v];return this}
    insert(v){this.mode='insert';this.values=Array.isArray(v)?v:[v];return this}
    upsert(v,opt){this.mode='upsert';this.values=Array.isArray(v)?v:[v];this.keys=opt?.onConflict||'id';return this}
    delete(){this.mode='delete';return this}
    get(){
      const tab=db[this.name]||[];
      const rows=tab.filter(x=>this.filters.every(fn=>fn(x))).slice(0,this.max);
      if(this.mode==='update')rows.forEach(x=>Object.assign(x,this.values[0]));
      if(this.mode==='insert')tab.push(...this.values.map(v=>({...v})));
      if(this.mode==='upsert')for(const v of this.values){const keys=this.keys.split(',');const old=tab.find(x=>keys.every(k=>String(x[k])===String(v[k])));if(old)Object.assign(old,v);else tab.push({...v})}
      if(this.mode==='delete')db[this.name]=tab.filter(x=>!rows.includes(x));
      return {data:rows,error:null}
    }
    then(ok,bad){return Promise.resolve(this.get()).then(ok,bad)}
    maybeSingle(){const r=this.get();return Promise.resolve({data:r.data[0]||null,error:null})}
    single(){return this.maybeSingle()}
  }
  const admin={from:name=>new Q(name)},school={id:'s',timezone:'America/Los_Angeles'},teacher={id:'teacher'},room={id:'r1',school_id:'s',timezone:'America/Los_Angeles'},settings={schedule_mode:'K Regular'};
  for(const [name,fn] of [['student',pub.resolveRoomSchedule],['teacher',staff.resolveRoomSchedule]]) {
    const old=await fn(admin,room,settings,{room_scheduling_enabled:false,auto_scheduling_enabled:true},{schedule_name:'Minimum'},'2099-11-03');
    verify(old.effectiveSchedule==='Minimum',name+' legacy calendar intact');
    const regular=await fn(admin,room,settings,{room_scheduling_enabled:true,auto_scheduling_enabled:true},null,'2099-11-02');
    verify(regular.effectiveSchedule==='K Regular',name+' primary schedule selected');
  }
  // Deleting the old master Regular must not close normal days before room scheduling is enabled.
  const legacyRegular=db.master_schedules.find(x=>x.schedule_name==='Regular');
  db.master_schedules=db.master_schedules.filter(x=>x!==legacyRegular);
  for(const [name,fn] of [['student',pub.resolveRoomSchedule],['teacher',staff.resolveRoomSchedule]]){
    const fallback=await fn(admin,room,settings,{room_scheduling_enabled:false,auto_scheduling_enabled:true},null,'2099-11-02');
    verify(fallback.effectiveSchedule==='K Regular',name+' legacy fallback uses room Primary when Regular deleted');
  }
  db.master_schedules.push(legacyRegular);
  let res=await staff.adminRoomSchedulingState(admin,school);
  verify(res.rooms.length===2&&res.legacyFutureCount===1,'school scoped admin state');
  res=await staff.adminAssignRoomSchedules(admin,teacher,school,{roomIds:['r1','other'],dayType:'Primary',schedule:'K Regular'});
  verify(!res.success,'cross-school assignment blocked');
  for(const [id,normal,special] of [['r1','K Regular','K Minimum'],['r2','2 Regular','2 Minimum']]){
    res=await staff.adminAssignRoomSchedules(admin,teacher,school,{roomIds:[id],dayType:'Primary',schedule:normal});
    verify(res.success,id+' primary assigned');
    res=await staff.adminAssignRoomSchedules(admin,teacher,school,{roomIds:[id],dayType:'Minimum',schedule:special});
    verify(res.success,id+' special assigned');
  }
  res=await staff.adminAssignRoomSchedules(admin,teacher,school,{roomIds:['r1'],dayType:'Regular',schedule:'K Regular'});
  verify(res.success,'legacy Regular assignment alias still works');
  res=await staff.adminSaveDayExceptions(admin,teacher,school,{dates:['2099-11-04'],dayType:'Primary'});
  verify(!res.success,'Primary cannot be saved as special-day exception');
  res=await staff.adminSaveDayExceptions(admin,teacher,school,{dates:['2099-11-03'],dayType:'Minimum'});
  verify(res.success&&res.added===1,'exception-only date saved');
  const special=await pub.resolveRoomSchedule(admin,room,settings,{room_scheduling_enabled:true,auto_scheduling_enabled:true},null,'2099-11-03');
  verify(special.effectiveSchedule==='K Minimum','per-room exception resolved');
  const absent=await pub.resolveRoomSchedule(admin,{...room,id:'unassigned'},settings,{room_scheduling_enabled:true,auto_scheduling_enabled:true},null,'2099-11-03');
  verify(absent.effectiveSchedule==='__UNASSIGNED_SPECIAL_DAY__','missing special mapping fails closed');
  res=await staff.adminSetRoomSchedulingEnabled(admin,teacher,school,{enabled:true});
  verify(!res.success&&res.message.includes('old calendar'),'legacy calendar needs acknowledgement');
  db.waiting_requests.push({id:'q1',room_id:'r1',status:'WAITING'});
  res=await staff.adminSetRoomSchedulingEnabled(admin,teacher,school,{enabled:true,acknowledgeLegacyCalendar:true});
  verify(!res.success,'active waitlist blocks switching');
  db.waiting_requests.length=0;
  res=await staff.adminSetRoomSchedulingEnabled(admin,teacher,school,{enabled:true,acknowledgeLegacyCalendar:true});
  verify(res.success&&db.school_settings[0].room_scheduling_enabled,'opt-in enabled after validation');
  db.passes.push({id:'p1',room_id:'r1',return_at:null});
  res=await staff.adminAssignRoomSchedules(admin,teacher,school,{roomIds:['r1'],dayType:'Minimum',schedule:'K Minimum'});
  verify(!res.success,'cannot change live schedule while pass active');
  verify(db.room_settings.find(x=>x.room_id==='other').schedule_mode==='Regular','other school untouched');
  return tests;
}

const tests=await testScheduling(staffSource,publicSource);
console.log('Hall Pilot 1.15: '+tests.length+' synthetic scheduling tests passed.');
