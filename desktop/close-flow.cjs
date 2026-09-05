const CLOSE_COPY={
 ar:{title:'الكرنه للعطور',message:'هل تريد حفظ نسخة احتياطية قبل إغلاق البرنامج؟',buttons:['نعم، حفظ نسخة','لا، خروج','إلغاء'],saveTitle:'حفظ النسخة الاحتياطية',filterName:'نسخة الكرنه للعطور',failure:'تعذر إنشاء النسخة الاحتياطية. لن يتم إغلاق البرنامج.',ok:'حسنًا'},
 fr:{title:'Al Karna — Parfums',message:'Voulez-vous enregistrer une sauvegarde avant de quitter ?',buttons:['Oui, sauvegarder','Non, quitter','Annuler'],saveTitle:'Enregistrer la sauvegarde',filterName:'Sauvegarde Al Karna Parfums',failure:"Impossible de créer la sauvegarde. L’application reste ouverte.",ok:'OK'}
};
function normalizeLocale(value){return value==='fr'?'fr':'ar'}
function closeCopy(locale){return CLOSE_COPY[normalizeLocale(locale)]}
function backupFilename(now=new Date()){const p=n=>String(n).padStart(2,'0');return `AlKarna-Perfume-backup-${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.conta.json`}
function createCloseFlow({dialog,window:windowValue,fetchBackup,writeBackup,approveQuit,onFailure,getLocale=async()=> 'ar'}){
 let active=false,approved=false;
 async function requestClose(){
  if(approved||active)return approved;active=true;
  try{const locale=normalizeLocale(await getLocale()),copy=closeCopy(locale);const {response}=await dialog.showMessageBox(windowValue(),{type:'question',title:copy.title,message:copy.message,buttons:copy.buttons,defaultId:0,cancelId:2,noLink:true});
   if(response===2)return false;
   if(response===1){approved=true;await approveQuit();return true}
   const saved=await dialog.showSaveDialog(windowValue(),{title:copy.saveTitle,defaultPath:backupFilename(),filters:[{name:copy.filterName,extensions:['conta.json','json']}]});
   if(saved.canceled||!saved.filePath)return false;
   try{const bytes=await fetchBackup();await writeBackup(saved.filePath,bytes)}catch(error){await onFailure(error);await dialog.showMessageBox(windowValue(),{type:'error',title:copy.title,message:copy.failure,buttons:[copy.ok],defaultId:0,cancelId:0,noLink:true});return false}
   approved=true;await approveQuit();return true;
  }finally{active=false}
 }
 return{requestClose,isApproved:()=>approved,isActive:()=>active};
}
module.exports={backupFilename,closeCopy,createCloseFlow};
