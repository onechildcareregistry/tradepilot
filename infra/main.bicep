targetScope = 'subscription'
@description('Resource group for the isolated TradePilot experiment.')
param resourceGroupName string = 'rg-tradepilot'
param location string = 'canadacentral'
param deployApplications bool = false
param image string
param sqlAdminObjectId string
param sqlAdminLogin string
param alertEmail string
param azureOpenAiEndpoint string
param azureOpenAiDeployment string = 'tradepilot-gpt-5-6-luna'
param researchHour int = 6
param researchMinute int = 15
param researchCronUtc string = '15 13,14 * * 1-5'
param tradingEnabled bool = false
param dataVerified bool = false
param emailFrom string
param emailTo string
param budgetStartDate string

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: { application: 'TradePilot', mode: 'Monopoly' }
}
module app './modules/resources.bicep' = {
  name: 'tradepilot-resources'
  scope: rg
  params: {
    location: location
    deployApplications: deployApplications
    image: image
    sqlAdminObjectId: sqlAdminObjectId
    sqlAdminLogin: sqlAdminLogin
    alertEmail: alertEmail
    azureOpenAiEndpoint: azureOpenAiEndpoint
    azureOpenAiDeployment: azureOpenAiDeployment
    researchHour: researchHour
    researchMinute: researchMinute
    researchCronUtc: researchCronUtc
    tradingEnabled: tradingEnabled
    dataVerified: dataVerified
    emailFrom: emailFrom
    emailTo: emailTo
    budgetStartDate: budgetStartDate
  }
}
output dashboardUrl string = app.outputs.dashboardUrl
output reportUrl string = app.outputs.reportUrl
output sqlServer string = app.outputs.sqlServer
output identityName string = app.outputs.identityName
output identityPrincipalId string = app.outputs.identityPrincipalId
output keyVaultName string = app.outputs.keyVaultName
output staticSiteName string = app.outputs.staticSiteName
