// Starter telemetry example for the classroom simulator template.
package frc.robot;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.networktables.IntegerPublisher;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StructPublisher;
import edu.wpi.first.wpilibj.TimedRobot;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.CommandScheduler;

public class Robot extends TimedRobot {
    private final RobotContainer container = new RobotContainer();

    private final IntegerPublisher counterPub =
        NetworkTableInstance.getDefault()
            .getIntegerTopic("/SmartDashboard/counter")
            .publish();

    private final StructPublisher<Pose2d> posePub =
        NetworkTableInstance.getDefault()
            .getStructTopic("/SmartDashboard/robotPose", Pose2d.struct)
            .publish();

    private final Timer timer = new Timer();
    private long counter = 0;

    @Override
    public void robotInit() {
        timer.start();
    }

    @Override
    public void robotPeriodic() {
        CommandScheduler.getInstance().run();

        counter++;
        counterPub.set(counter);

        double seconds = timer.get();
        double radius = 2.0;
        double omega = 1.0;
        double x = 4.0 + radius * Math.cos(omega * seconds);
        double y = 4.0 + radius * Math.sin(omega * seconds);
        Rotation2d heading = new Rotation2d(omega * seconds + Math.PI / 2);
        posePub.set(new Pose2d(x, y, heading));
    }
}
