function backupFilename(now=new Date()){const p=n=>String(n).padStart(2,'0');return `AlKarna-backup-${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.conta.json`}
function createCloseFlow({dialog,window:windowValue,fetchBackup,writeBackup,approveQuit,onFailure}){
 let active=false,approved=false;
 async function requestClose(){
  if(approved||active)return approved;active=true;
  try{const {response}=await dialog.showMessageBox(windowValue(),{type:'question',title:'الكرنه',message:'هل تريد إنشاء نسخة احتياطية قبل الخروج؟',buttons:['نعم، إنشاء نسخة','لا، خروج','إلغاء'],defaultId:0,cancelId:2,noLink:true});
   if(response===2)return false;
   if(response===1){approved=true;await approveQuit();return true}
   const saved=await dialog.showSaveDialog(windowValue(),{title:'حفظ النسخة الاحتياطية',defaultPath:backupFilename(),filters:[{name:'نسخة الكرنه',extensions:['conta.json','json']}]});
   if(saved.canceled||!saved.filePath)return false;
   try{const bytes=await fetchBackup();await writeBackup(saved.filePath,bytes)}catch(error){await onFailure(error);return false}
   approved=true;await approveQuit();return true;
  }finally{active=false}
 }
 return{requestClose,isApproved:()=>approved,isActive:()=>active};
}
module.exports={backupFilename,createCloseFlow};
