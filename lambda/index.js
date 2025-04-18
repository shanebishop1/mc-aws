const { EC2Client, StartInstancesCommand } = require("@aws-sdk/client-ec2");

const ec2 = new EC2Client({ region: process.env.AWS_REGION });

exports.handler = async () => {
  await ec2.send(
    new StartInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] })
  );
  return { statusCode: 200, body: "Server starting…" };
};
