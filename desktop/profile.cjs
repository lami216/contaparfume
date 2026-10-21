/* eslint-disable @typescript-eslint/no-require-imports */
const {join}=require('node:path');

// Packaged channels come only from package.json inside app.asar. Environment
// variables and command-line arguments must never switch a customer profile.
function desktopProfile({isPackaged,channel,appData,localAppData}) {
  const selected=isPackaged?(channel??'production'):'sandbox';
  const profiles={
    production:{directory:'AlKarna-Perfume',name:'الكرنة للعطور',appId:'mr.alkarna.perfume.desktop'},
    sandbox:{directory:'AlKarna-Perfume-Sandbox',name:'الكرنة للعطور — نسخة التجربة',appId:'mr.alkarna.perfume.sandbox'},
    store:{directory:'AlKarna-Perfume-Store',name:'الكرنة للعطور',appId:'mr.alkarna.perfume.store'},
    'store-validation':{directory:'AlKarna-Perfume-MSIX-Validation',name:'الكرنة للعطور — فحص MSIX',appId:'mr.alkarna.perfume.msixvalidation'},
  };
  if(!Object.hasOwn(profiles,selected))throw new Error(`Unknown packaged desktop channel: ${selected}`);
  const profile=profiles[selected],userData=join(appData,profile.directory);
  return Object.freeze({...profile,channel:selected,userData,
    databasePath:join(userData,'data','alkarna-perfume.sqlite'),
    licenseStatePath:selected==='production'
      ?join(localAppData||userData,'PayZone','AlKarna-Perfume-Licensing','state-v2.json')
      :join(userData,'licensing','state-v2.json'),
  });
}

module.exports={desktopProfile};
