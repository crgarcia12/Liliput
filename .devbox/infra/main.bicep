targetScope = 'subscription'

@description('Base name prefix for all devbox resources')
param namePrefix string = 'crgar-liliput'

@description('Azure region')
param location string = 'swedencentral'

@description('Kubernetes version for AKS')
param kubernetesVersion string = '1.34'

@description('Node count for the AKS system pool')
@minValue(1)
@maxValue(5)
param nodeCount int = 1

@description('VM size for AKS nodes')
param nodeVmSize string = 'Standard_D2s_v5'

var rgName  = '${namePrefix}-rg'
var aksName = '${namePrefix}-aks'
// ACR name: 5-50 alphanum only, globally unique
var acrName = toLower(replace('${namePrefix}acr', '-', ''))
var lawName = '${namePrefix}-law'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
}

module law 'modules/law.bicep' = {
  name: 'law'
  scope: rg
  params: {
    name: lawName
    location: location
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  scope: rg
  params: {
    name: acrName
    location: location
  }
}

module aks 'modules/aks.bicep' = {
  name: 'aks'
  scope: rg
  params: {
    name: aksName
    location: location
    kubernetesVersion: kubernetesVersion
    nodeCount: nodeCount
    nodeVmSize: nodeVmSize
    logAnalyticsWorkspaceId: law.outputs.id
    acrId: acr.outputs.id
  }
}

output resourceGroupName string = rg.name
output aksName string = aks.outputs.name
output acrName string = acr.outputs.name
output acrLoginServer string = acr.outputs.loginServer
