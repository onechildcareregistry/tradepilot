param location string
param deployApplications bool = false
param image string
param sqlAdminObjectId string
param sqlAdminLogin string
param alertEmail string
param azureOpenAiEndpoint string
param azureOpenAiDeployment string
param researchHour int = 6
param researchMinute int = 15
param researchCronUtc string = '15 13,14 * * 1-5'
param tradingEnabled bool
param dataVerified bool
param emailFrom string
param emailTo string
param budgetStartDate string
var suffix = uniqueString(resourceGroup().id)
var prefix = 'tradepilot'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-identity'
  location: location
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-tp-${suffix}'
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}
resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'secret-reader')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'logs-${prefix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.05') }
  }
}
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${prefix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'sttp${suffix}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: true
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [{ allowedOrigins: ['https://${site.properties.defaultHostname}'], allowedMethods: ['GET','HEAD'], allowedHeaders: ['*'], exposedHeaders: ['ETag'], maxAgeInSeconds: 300 }]
    }
  }
}
resource reports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'reports'
  properties: { publicAccess: 'Blob' }
}
resource archive 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'archive'
  properties: { publicAccess: 'None' }
}
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [{
        name: 'expire-private-observations'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['archive/observations/'] }
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 60 } } }
        }
      }]
    }
  }
}
resource blobWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, 'blob-writer')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource server 'Microsoft.Sql/servers@2023-08-01' = {
  name: 'sql-tp-${suffix}'
  location: location
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'User'
      login: sqlAdminLogin
      sid: sqlAdminObjectId
      tenantId: tenant().tenantId
      azureADOnlyAuthentication: true
    }
  }
}
resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: server
  name: 'tradepilot'
  location: location
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: { maxSizeBytes: 2147483648, requestedBackupStorageRedundancy: 'Local' }
}
resource firewall 'Microsoft.Sql/servers/firewallRules@2023-08-01' = {
  parent: server
  name: 'AzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}
resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'web-${prefix}-${suffix}'
  location: 'eastus2'
  sku: { name: 'Free', tier: 'Free' }
  properties: { allowConfigFileUpdates: true }
}
var commonEnv = [
  { name: 'RESEARCH_HOUR', value: string(researchHour) }
  { name: 'RESEARCH_MINUTE', value: string(researchMinute) }
  { name: 'TRADEPILOT_MODE', value: 'Monopoly' }
  { name: 'TRADING_ENABLED', value: string(tradingEnabled) }
  { name: 'DATA_VERIFIED', value: string(dataVerified) }
  { name: 'DATABASE', value: 'azure-sql' }
  { name: 'SQL_SERVER', value: server.properties.fullyQualifiedDomainName }
  { name: 'SQL_DATABASE', value: database.name }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'STORAGE_ACCOUNT', value: storage.name }
  { name: 'EMAIL_FROM', value: emailFrom }
  { name: 'EMAIL_TO', value: emailTo }
  { name: 'RESEND_API_KEY', secretRef: 'resend' }
]
var resendSecret = { name: 'resend', keyVaultUrl: '${vault.properties.vaultUri}secrets/resend-api-key', identity: identity.id }
resource worker 'Microsoft.App/containerApps@2024-03-01' = if (deployApplications) {
  name: 'app-${prefix}-worker'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        resendSecret
        { name: 'finnhub-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/finnhub-api-key', identity: identity.id }
      ]
    }
    template: {
      containers: [{
        name: 'worker'
        image: image
        command: ['node', 'dist/cli.js', 'worker']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: concat(commonEnv, [{ name: 'FINNHUB_API_KEY', secretRef: 'finnhub-key' }])
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'market-hours', custom: { type: 'cron', metadata: { timezone: 'America/New_York', start: '0 8 * * 1-5', end: '10 16 * * 1-5', desiredReplicas: '1' } } }]
      }
    }
  }
  dependsOn: [secretReader, blobWriter, firewall]
}
resource morning 'Microsoft.App/jobs@2024-03-01' = if (deployApplications) {
  name: 'job-${prefix}-morning'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: researchCronUtc, parallelism: 1, replicaCompletionCount: 1 }
      secrets: [resendSecret, { name: 'azure-openai-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/azure-openai-api-key', identity: identity.id }]
    }
    template: {
      containers: [{ name: 'research', image: image, command: ['node','dist/cli.js','research'], resources: { cpu: json('0.25'), memory: '0.5Gi' }, env: concat(commonEnv,[{ name:'AI_PROVIDER', value:'azure-openai' },{ name:'AZURE_OPENAI_ENDPOINT', value:azureOpenAiEndpoint },{ name:'AZURE_OPENAI_DEPLOYMENT', value:azureOpenAiDeployment },{ name:'AZURE_OPENAI_API_KEY', secretRef:'azure-openai-key' },{ name:'AI_REASONING_EFFORT', value:'low' }]) }]
    }
  }
  dependsOn: [secretReader, blobWriter]
}
resource maintenance 'Microsoft.App/jobs@2024-03-01' = if (deployApplications) {
  name: 'job-${prefix}-archive'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: { triggerType:'Schedule', replicaTimeout:600, replicaRetryLimit:1, scheduleTriggerConfig:{ cronExpression:'30 21 * * 1-5', parallelism:1, replicaCompletionCount:1 }, secrets:[resendSecret] }
    template: { containers:[{ name:'archive', image:image, command:['node','dist/cli.js','archive'], resources:{ cpu:json('0.25'), memory:'0.5Gi' }, env:commonEnv }] }
  }
  dependsOn: [secretReader, blobWriter]
}
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'tradepilot-monthly'
  properties: {
    category: 'Cost'
    amount: 10
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      half: { enabled:true, operator:'GreaterThanOrEqualTo', threshold:50, thresholdType:'Actual', contactEmails:[alertEmail] }
      approaching: { enabled:true, operator:'GreaterThanOrEqualTo', threshold:80, thresholdType:'Actual', contactEmails:[alertEmail] }
      limit: { enabled:true, operator:'GreaterThanOrEqualTo', threshold:100, thresholdType:'Actual', contactEmails:[alertEmail] }
    }
  }
}
output dashboardUrl string = 'https://${site.properties.defaultHostname}'
output reportUrl string = '${storage.properties.primaryEndpoints.blob}reports/report.json'
output sqlServer string = server.properties.fullyQualifiedDomainName
output identityName string = identity.name
output identityPrincipalId string = identity.properties.principalId
output keyVaultName string = vault.name
output staticSiteName string = site.name
