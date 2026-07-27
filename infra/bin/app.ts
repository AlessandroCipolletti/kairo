#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { KairoHostingStack } from '../lib/hosting-stack.js'

const app = new cdk.App()

// Prefer values from project .env (set by npm run deploy) over CLI defaults.
const account = process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT
const region = process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION

if (!account || !region) {
  throw new Error('CDK_DEFAULT_ACCOUNT/AWS_ACCOUNT_ID and CDK_DEFAULT_REGION/AWS_REGION are required')
}

new KairoHostingStack(app, 'KairoHostingStack', {
  env: { account, region },
  description: 'Kairo static hosting — S3 + CloudFront (cost-light)',
})
