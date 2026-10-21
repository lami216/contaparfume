const validationIdentity=Object.freeze({
  identityName:'AlKarna.Perfume.MSIXValidation',
  publisher:'CN=AlKarnaLocalValidation',
  publisherDisplayName:'AlKarna Local Validation',
  displayName:'الكرنة للعطور — فحص MSIX',
});

export function channelConfig(channel,version,identity) {
  if(!/^\d+\.\d+\.\d+$/.test(version)||version.split('.').some(part=>Number(part)>65535))throw new Error('MSIX requires three numeric version components, each <= 65535; revision is always 0.');
  if(channel==='sandbox')return {
    appId:'mr.alkarna.perfume.sandbox',productName:'الكرنة للعطور — نسخة التجربة',
    executableName:'AlKarnaPerfumeSandbox',extraMetadata:{alkarnaChannel:'sandbox'},
    directories:{output:'dist/sandbox'},
    win:{target:[{target:'zip',arch:['x64']}],artifactName:'AlKarna-Perfume-Sandbox-x64.zip'},
  };
  if(channel!=='store'&&channel!=='store-validation')throw new Error(`Unknown build channel: ${channel}`);
  const selected=channel==='store-validation'?validationIdentity:identity;
  if(!selected)throw new Error('Store identity is required. Copy the values from Partner Center > Product identity into store-identity.local.json.');
  for(const key of ['identityName','publisher','publisherDisplayName','displayName']) {
    if(typeof selected[key]!=='string'||!selected[key].trim()||/[\r\n\u0000]/.test(selected[key]))throw new Error(`Missing or invalid Store identity field: ${key}`);
  }
  if(!/^[A-Za-z0-9.-]{3,50}$/.test(selected.identityName)||!selected.publisher.startsWith('CN='))throw new Error('Invalid Store identity. Use the exact Package/Identity/Name and Package/Identity/Publisher from Partner Center.');
  if(channel==='store'&&/MSIXValidation|LocalValidation|REPLACE|EXAMPLE|PLACEHOLDER/i.test(JSON.stringify(selected)))throw new Error('Validation/placeholder identities cannot be used for a Store release.');
  return {
    appId:channel==='store'?'mr.alkarna.perfume.store':'mr.alkarna.perfume.msixvalidation',
    extraMetadata:{alkarnaChannel:channel},
    directories:{output:`dist/${channel}`},
    win:{target:[{target:'appx',arch:['x64']}]},
    appx:{...Object.fromEntries(['identityName','publisher','publisherDisplayName','displayName'].map(key=>[key,selected[key]])),applicationId:'AlKarnaPerfume',languages:['ar','fr'],
      minVersion:'10.0.19041.0',maxVersionTested:'10.0.19041.0',
      capabilities:['runFullTrust'],setBuildNumber:false,
      artifactName:channel==='store'?'AlKarna-Perfume-Store-${version}-x64.msix':'NOT-FOR-STORE-AlKarna-Validation-${version}-x64.msix',
    },
  };
}
